using System.Globalization;
using System.Text.Json;
using AiToolkit.Web;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.AspNetCore.StaticFiles;
using Microsoft.Data.Sqlite;

var builder = WebApplication.CreateSlimBuilder(new WebApplicationOptions
{
    Args = args,
    WebRootPath = ToolkitPaths.ResolveWebRootPath(Directory.GetCurrentDirectory())
});

builder.WebHost.ConfigureKestrel(options =>
{
    options.Limits.MaxRequestBodySize = 1024L * 1024L * 1024L;
});

builder.Services.Configure<FormOptions>(options =>
{
    options.MultipartBodyLengthLimit = 1024L * 1024L * 1024L;
    options.ValueLengthLimit = int.MaxValue;
    options.MultipartHeadersLengthLimit = 64 * 1024;
});

builder.Services.ConfigureHttpJsonOptions(options =>
{
    options.SerializerOptions.TypeInfoResolverChain.Insert(0, AppJsonSerializerContext.Default);
});

builder.Services.AddSingleton<ToolkitPaths>();
builder.Services.AddSingleton<CpuUsageTracker>();
builder.Services.AddSingleton<ToolkitRepository>();
builder.Services.AddSingleton<JobManager>();
builder.Services.AddHostedService<QueueWorker>();

var app = builder.Build();

var repository = app.Services.GetRequiredService<ToolkitRepository>();
await repository.EnsureDatabaseAsync();
var bootstrapSettings = await repository.GetSettingsAsync();
Directory.CreateDirectory(bootstrapSettings.TrainingFolder);
Directory.CreateDirectory(bootstrapSettings.DatasetsFolder);
Directory.CreateDirectory(bootstrapSettings.DataRoot);
Directory.CreateDirectory(Path.Combine(bootstrapSettings.DataRoot, "images"));

var contentTypeProvider = new FileExtensionContentTypeProvider();
contentTypeProvider.Mappings[".safetensors"] = "application/octet-stream";
contentTypeProvider.Mappings[".mkv"] = "video/x-matroska";
contentTypeProvider.Mappings[".m4v"] = "video/x-m4v";
contentTypeProvider.Mappings[".flv"] = "video/x-flv";

app.Use(async (context, next) =>
{
    var configuredToken = Environment.GetEnvironmentVariable("AI_TOOLKIT_AUTH");
    if (string.IsNullOrWhiteSpace(configuredToken))
    {
        await next();
        return;
    }

    var path = context.Request.Path.Value ?? string.Empty;
    if (!path.StartsWith("/api/", StringComparison.OrdinalIgnoreCase))
    {
        await next();
        return;
    }

    if (path.StartsWith("/api/img/", StringComparison.OrdinalIgnoreCase) ||
        path.StartsWith("/api/files/", StringComparison.OrdinalIgnoreCase) ||
        string.Equals(path, "/api/meta", StringComparison.OrdinalIgnoreCase))
    {
        await next();
        return;
    }

    var header = context.Request.Headers.Authorization.ToString();
    string? providedToken = null;
    if (header.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase))
    {
        providedToken = header[7..].Trim();
    }

    if (!string.Equals(providedToken, configuredToken, StringComparison.Ordinal))
    {
        context.Response.StatusCode = StatusCodes.Status401Unauthorized;
        await context.Response.WriteAsJsonAsync(new ErrorResponse("Unauthorized"), AppJsonSerializerContext.Default.ErrorResponse);
        return;
    }

    await next();
});

app.UseDefaultFiles();
app.UseStaticFiles();

app.MapGet("/api/meta", (ToolkitPaths paths) =>
    Results.Ok(new MetaResponse(
        !string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable("AI_TOOLKIT_AUTH")),
        SystemInfoHelpers.GetPlatformName(),
        paths.ToolkitRoot)));

app.MapGet("/api/auth", () => Results.Ok(new AuthResponse(true)));

app.MapGet("/api/settings", async (ToolkitRepository repo) =>
    Results.Ok(await repo.GetSettingsAsync()));

app.MapPost("/api/settings", async Task<IResult> (HttpRequest request, ToolkitRepository repo, CancellationToken cancellationToken) =>
{
    var payload = await request.ReadFromJsonAsync(AppJsonSerializerContext.Default.SettingsUpdateRequest, cancellationToken);
    if (payload is null)
    {
        return ApiHelpers.Error("Invalid request body", StatusCodes.Status400BadRequest);
    }

    var normalized = new SettingsUpdateRequest(
        payload.HfToken ?? string.Empty,
        string.IsNullOrWhiteSpace(payload.TrainingFolder) ? bootstrapSettings.TrainingFolder : payload.TrainingFolder,
        string.IsNullOrWhiteSpace(payload.DatasetsFolder) ? bootstrapSettings.DatasetsFolder : payload.DatasetsFolder,
        string.IsNullOrWhiteSpace(payload.DataRoot) ? bootstrapSettings.DataRoot : payload.DataRoot);

    await repo.SaveSettingsAsync(normalized);
    Directory.CreateDirectory(normalized.TrainingFolder);
    Directory.CreateDirectory(normalized.DatasetsFolder);
    Directory.CreateDirectory(normalized.DataRoot);
    Directory.CreateDirectory(Path.Combine(normalized.DataRoot, "images"));

    return Results.Ok(new SuccessResponse(true));
});

app.MapGet("/api/jobs", async Task<IResult> (string? id, ToolkitRepository repo) =>
{
    if (!string.IsNullOrWhiteSpace(id))
    {
        var job = await repo.GetJobAsync(id);
        return job is null
            ? ApiHelpers.Error("Job not found", StatusCodes.Status404NotFound)
            : Results.Ok(job);
    }

    var jobs = await repo.GetJobsAsync();
    return Results.Ok(new JobsResponse(jobs));
});

app.MapPost("/api/jobs", async Task<IResult> (HttpRequest request, ToolkitRepository repo, JobManager jobManager, CancellationToken cancellationToken) =>
{
    ParsedJobSaveRequest parsed;
    try
    {
        using var document = await JsonDocument.ParseAsync(request.Body, cancellationToken: cancellationToken);
        parsed = ApiHelpers.ParseJobSaveRequest(document.RootElement);
    }
    catch (JsonException)
    {
        return ApiHelpers.Error("Invalid JSON body", StatusCodes.Status400BadRequest);
    }

    if (!parsed.IsValid)
    {
        return ApiHelpers.Error(parsed.Error ?? "Invalid request body", StatusCodes.Status400BadRequest);
    }

    var settings = await repo.GetSettingsAsync();
    var gpuIds = OperatingSystem.IsMacOS()
        ? "mps"
        : string.IsNullOrWhiteSpace(parsed.GpuIds) ? "0" : parsed.GpuIds.Trim();

    string normalizedConfig;
    try
    {
        normalizedConfig = jobManager.NormalizeJobConfig(parsed.JobConfig!, parsed.Name!, settings);
    }
    catch (Exception ex)
    {
        return ApiHelpers.Error(ex.Message, StatusCodes.Status400BadRequest);
    }

    try
    {
        var job = await repo.SaveJobAsync(parsed.Id, parsed.Name!, gpuIds, normalizedConfig);
        await repo.EnsureQueueAsync(gpuIds, false);
        return Results.Ok(job);
    }
    catch (SqliteException ex) when (ex.SqliteErrorCode == 19)
    {
        return ApiHelpers.Error("Job name already exists", StatusCodes.Status409Conflict);
    }
    catch (Exception ex)
    {
        return ApiHelpers.Error($"Failed to save job: {ex.Message}", StatusCodes.Status500InternalServerError);
    }
});

app.MapGet("/api/jobs/{jobId}", async Task<IResult> (string jobId, ToolkitRepository repo) =>
{
    var job = await repo.GetJobAsync(jobId);
    return job is null
        ? ApiHelpers.Error("Job not found", StatusCodes.Status404NotFound)
        : Results.Ok(job);
});

app.MapGet("/api/jobs/{jobId}/start", async Task<IResult> (string jobId, ToolkitRepository repo) =>
{
    var job = await repo.GetJobAsync(jobId);
    if (job is null)
    {
        return ApiHelpers.Error("Job not found", StatusCodes.Status404NotFound);
    }

    var queuePosition = await repo.GetNextQueuePositionAsync();
    await repo.EnsureQueueAsync(job.GpuIds, false);
    await repo.UpdateJobAsync(jobId, new ToolkitJobUpdate
    {
        Status = "queued",
        Stop = false,
        ReturnToQueue = false,
        Info = "Job queued",
        QueuePosition = queuePosition,
        SetPidToNull = true
    });

    var updated = await repo.GetJobAsync(jobId);
    return Results.Ok(updated!);
});

app.MapGet("/api/jobs/{jobId}/stop", async Task<IResult> (string jobId, ToolkitRepository repo, JobManager jobManager) =>
{
    var job = await repo.GetJobAsync(jobId);
    if (job is null)
    {
        return ApiHelpers.Error("Job not found", StatusCodes.Status404NotFound);
    }

    await jobManager.RequestStopAsync(job, requeue: false);
    var updated = await repo.GetJobAsync(jobId) ?? job;
    return Results.Ok(updated);
});

app.MapGet("/api/jobs/{jobId}/delete", async Task<IResult> (string jobId, ToolkitRepository repo, JobManager jobManager) =>
{
    var job = await repo.GetJobAsync(jobId);
    if (job is null)
    {
        return ApiHelpers.Error("Job not found", StatusCodes.Status404NotFound);
    }

    if (job.Status is "running" or "stopping")
    {
        await jobManager.RequestStopAsync(job, requeue: false);
        await Task.Delay(1000);
    }

    try
    {
        await jobManager.DeleteJobArtifactsAsync(job);
        await repo.DeleteJobAsync(jobId);
        return Results.Ok(job);
    }
    catch (Exception ex)
    {
        return ApiHelpers.Error($"Failed to delete job: {ex.Message}", StatusCodes.Status500InternalServerError);
    }
});

app.MapGet("/api/jobs/{jobId}/mark_stopped", async Task<IResult> (string jobId, ToolkitRepository repo) =>
{
    var job = await repo.GetJobAsync(jobId);
    if (job is null)
    {
        return ApiHelpers.Error("Job not found", StatusCodes.Status404NotFound);
    }

    await repo.UpdateJobAsync(jobId, new ToolkitJobUpdate
    {
        Status = "stopped",
        Stop = true,
        Info = "Job stopped",
        SetPidToNull = true
    });

    var updated = await repo.GetJobAsync(jobId) ?? job;
    return Results.Ok(updated);
});

app.MapGet("/api/jobs/{jobId}/log", async Task<IResult> (string jobId, ToolkitRepository repo, JobManager jobManager) =>
{
    var job = await repo.GetJobAsync(jobId);
    if (job is null)
    {
        return ApiHelpers.Error("Job not found", StatusCodes.Status404NotFound);
    }

    var log = await jobManager.ReadLogAsync(job);
    return Results.Ok(new JobLogResponse(log));
});

app.MapGet("/api/jobs/{jobId}/samples", async Task<IResult> (string jobId, ToolkitRepository repo, JobManager jobManager) =>
{
    var job = await repo.GetJobAsync(jobId);
    if (job is null)
    {
        return ApiHelpers.Error("Job not found", StatusCodes.Status404NotFound);
    }

    var samples = await jobManager.GetSamplesAsync(job);
    return Results.Ok(new SamplesResponse(samples.ToArray()));
});

app.MapGet("/api/jobs/{jobId}/files", async Task<IResult> (string jobId, ToolkitRepository repo, JobManager jobManager) =>
{
    var job = await repo.GetJobAsync(jobId);
    if (job is null)
    {
        return ApiHelpers.Error("Job not found", StatusCodes.Status404NotFound);
    }

    var files = await jobManager.GetModelFilesAsync(job);
    return Results.Ok(new JobFilesResponse(files.ToArray()));
});

app.MapGet("/api/jobs/{jobId}/loss", async Task<IResult> (string jobId, HttpRequest request, ToolkitRepository repo, JobManager jobManager) =>
{
    var job = await repo.GetJobAsync(jobId);
    if (job is null)
    {
        return ApiHelpers.Error("Job not found", StatusCodes.Status404NotFound);
    }

    var query = request.Query;
    var key = string.IsNullOrWhiteSpace(query["key"]) ? "loss" : query["key"].ToString();
    var limit = ApiHelpers.ReadInt(query["limit"].ToString(), 2000, 1, 20000);
    var stride = ApiHelpers.ReadInt(query["stride"].ToString(), 1, 1, 1000);
    var sinceStep = ApiHelpers.TryReadNullableInt(query["since_step"].ToString());

    var loss = await jobManager.ReadLossAsync(job, key, limit, sinceStep, stride);
    return Results.Ok(loss);
});

app.MapGet("/api/queue", async Task<IResult> (ToolkitRepository repo) =>
{
    await ApiHelpers.EnsureQueuesForCurrentHardwareAsync(repo);
    var queues = await repo.GetQueuesAsync();
    return Results.Ok(new QueuesResponse(queues));
});

app.MapGet("/api/queue/{queueId}/start", async Task<IResult> (string queueId, ToolkitRepository repo) =>
{
    await repo.SetQueueRunningAsync(queueId, true);
    var queue = await repo.GetQueueAsync(queueId);
    return Results.Ok(queue!);
});

app.MapGet("/api/queue/{queueId}/stop", async Task<IResult> (string queueId, ToolkitRepository repo, JobManager jobManager) =>
{
    await repo.SetQueueRunningAsync(queueId, false);
    var jobs = await repo.GetJobsForGpuAsync(queueId, "running", "stopping");
    foreach (var job in jobs)
    {
        if (!job.ReturnToQueue || !job.Stop)
        {
            await jobManager.RequestStopAsync(job, requeue: true);
        }
    }

    var queue = await repo.GetQueueAsync(queueId);
    return Results.Ok(queue!);
});

app.MapGet("/api/datasets/list", async Task<IResult> (ToolkitRepository repo) =>
{
    var settings = await repo.GetSettingsAsync();
    Directory.CreateDirectory(settings.DatasetsFolder);
    var datasets = Directory.GetDirectories(settings.DatasetsFolder)
        .Select(static path => Path.GetFileName(path) ?? string.Empty)
        .Where(name => !string.IsNullOrWhiteSpace(name) && !name.StartsWith('.'))
        .OrderBy(name => name, StringComparer.OrdinalIgnoreCase)
        .ToArray()!;

    return Results.Ok(new DatasetListResponse(datasets));
});

app.MapPost("/api/datasets/create", async Task<IResult> (HttpRequest request, ToolkitRepository repo, CancellationToken cancellationToken) =>
{
    var payload = await request.ReadFromJsonAsync(AppJsonSerializerContext.Default.CreateDatasetRequest, cancellationToken);
    if (payload is null || string.IsNullOrWhiteSpace(payload.Name))
    {
        return ApiHelpers.Error("Dataset name is required", StatusCodes.Status400BadRequest);
    }

    var settings = await repo.GetSettingsAsync();
    Directory.CreateDirectory(settings.DatasetsFolder);
    var sanitizedName = ApiHelpers.SanitizeDatasetName(payload.Name);
    if (string.IsNullOrWhiteSpace(sanitizedName))
    {
        return ApiHelpers.Error("Dataset name is invalid", StatusCodes.Status400BadRequest);
    }

    var datasetPath = ApiHelpers.ResolveChildPath(settings.DatasetsFolder, sanitizedName);
    Directory.CreateDirectory(datasetPath);
    return Results.Ok(new DatasetCreateResponse(true, sanitizedName));
});

app.MapPost("/api/datasets/delete", async Task<IResult> (HttpRequest request, ToolkitRepository repo, CancellationToken cancellationToken) =>
{
    var payload = await request.ReadFromJsonAsync(AppJsonSerializerContext.Default.DeleteDatasetRequest, cancellationToken);
    if (payload is null || string.IsNullOrWhiteSpace(payload.Name))
    {
        return ApiHelpers.Error("Dataset name is required", StatusCodes.Status400BadRequest);
    }

    var settings = await repo.GetSettingsAsync();
    var datasetPath = ApiHelpers.ResolveChildPath(settings.DatasetsFolder, payload.Name);
    if (Directory.Exists(datasetPath))
    {
        Directory.Delete(datasetPath, recursive: true);
    }

    return Results.Ok(new SuccessResponse(true));
});

app.MapPost("/api/datasets/listImages", async Task<IResult> (HttpRequest request, ToolkitRepository repo, CancellationToken cancellationToken) =>
{
    var payload = await request.ReadFromJsonAsync(AppJsonSerializerContext.Default.ListImagesRequest, cancellationToken);
    if (payload is null || string.IsNullOrWhiteSpace(payload.DatasetName))
    {
        return ApiHelpers.Error("Dataset name is required", StatusCodes.Status400BadRequest);
    }

    var settings = await repo.GetSettingsAsync();
    var datasetPath = ApiHelpers.ResolveChildPath(settings.DatasetsFolder, payload.DatasetName);
    if (!Directory.Exists(datasetPath))
    {
        return ApiHelpers.Error($"Folder '{payload.DatasetName}' not found", StatusCodes.Status404NotFound);
    }

    var images = ApiHelpers.FindMediaFilesRecursively(datasetPath)
        .Select(path => new DatasetImageItem(path))
        .ToArray();

    return Results.Ok(new DatasetImagesResponse(images));
});

app.MapPost("/api/datasets/upload", async Task<IResult> (HttpRequest request, ToolkitRepository repo, CancellationToken cancellationToken) =>
{
    var settings = await repo.GetSettingsAsync();
    var form = await request.ReadFormAsync(cancellationToken);
    var datasetName = form["datasetName"].ToString();
    if (string.IsNullOrWhiteSpace(datasetName))
    {
        return ApiHelpers.Error("datasetName is required", StatusCodes.Status400BadRequest);
    }

    var files = form.Files;
    if (files.Count == 0)
    {
        return ApiHelpers.Error("No files provided", StatusCodes.Status400BadRequest);
    }

    var uploadDir = ApiHelpers.ResolveChildPath(settings.DatasetsFolder, datasetName);
    Directory.CreateDirectory(uploadDir);

    var savedFiles = new List<string>(files.Count);
    foreach (var file in files)
    {
        var cleanedName = ApiHelpers.SanitizeUploadedFileName(file.FileName);
        var destinationPath = Path.Combine(uploadDir, cleanedName);
        await ApiHelpers.SaveFormFileAsync(file, destinationPath, cancellationToken);
        savedFiles.Add(cleanedName);
    }

    return Results.Ok(new UploadResponse("Files uploaded successfully", savedFiles.ToArray()));
});

app.MapPost("/api/img/upload", async Task<IResult> (HttpRequest request, ToolkitRepository repo, CancellationToken cancellationToken) =>
{
    var settings = await repo.GetSettingsAsync();
    var form = await request.ReadFormAsync(cancellationToken);
    var files = form.Files;
    if (files.Count == 0)
    {
        return ApiHelpers.Error("No files provided", StatusCodes.Status400BadRequest);
    }

    var imageRoot = ApiHelpers.ResolveChildPath(settings.DataRoot, "images");
    Directory.CreateDirectory(imageRoot);

    var savedFiles = new List<string>(files.Count);
    foreach (var file in files)
    {
        var extension = Path.GetExtension(file.FileName);
        if (string.IsNullOrWhiteSpace(extension))
        {
            extension = ".bin";
        }

        var fileName = Guid.NewGuid().ToString("N") + extension.ToLowerInvariant();
        var destinationPath = Path.Combine(imageRoot, fileName);
        await ApiHelpers.SaveFormFileAsync(file, destinationPath, cancellationToken);
        savedFiles.Add(destinationPath);
    }

    return Results.Ok(new UploadResponse("Files uploaded successfully", savedFiles.ToArray()));
});

app.MapPost("/api/img/delete", async Task<IResult> (HttpRequest request, ToolkitRepository repo, CancellationToken cancellationToken) =>
{
    var payload = await request.ReadFromJsonAsync(AppJsonSerializerContext.Default.DeleteImageRequest, cancellationToken);
    if (payload is null || string.IsNullOrWhiteSpace(payload.ImgPath))
    {
        return ApiHelpers.Error("imgPath is required", StatusCodes.Status400BadRequest);
    }

    var settings = await repo.GetSettingsAsync();
    var allowedRoots = new[] { settings.DatasetsFolder, settings.TrainingFolder, settings.DataRoot };
    if (!ApiHelpers.IsAllowedFilePath(payload.ImgPath, allowedRoots))
    {
        return ApiHelpers.Error("Invalid image path", StatusCodes.Status400BadRequest);
    }

    if (File.Exists(payload.ImgPath))
    {
        File.Delete(payload.ImgPath);
    }

    var captionPath = Path.ChangeExtension(payload.ImgPath, ".txt");
    if (captionPath is not null && File.Exists(captionPath))
    {
        File.Delete(captionPath);
    }

    return Results.Ok(new SuccessResponse(true));
});

app.MapPost("/api/img/caption", async Task<IResult> (HttpRequest request, ToolkitRepository repo, CancellationToken cancellationToken) =>
{
    var payload = await request.ReadFromJsonAsync(AppJsonSerializerContext.Default.CaptionRequest, cancellationToken);
    if (payload is null || string.IsNullOrWhiteSpace(payload.ImgPath))
    {
        return ApiHelpers.Error("imgPath is required", StatusCodes.Status400BadRequest);
    }

    var settings = await repo.GetSettingsAsync();
    if (!ApiHelpers.IsAllowedFilePath(payload.ImgPath, new[] { settings.DatasetsFolder }))
    {
        return ApiHelpers.Error("Invalid image path", StatusCodes.Status400BadRequest);
    }

    if (!File.Exists(payload.ImgPath))
    {
        return ApiHelpers.Error("Image does not exist", StatusCodes.Status404NotFound);
    }

    var captionPath = Path.ChangeExtension(payload.ImgPath, ".txt");
    await File.WriteAllTextAsync(captionPath!, payload.Caption ?? string.Empty, cancellationToken);
    return Results.Ok(new SuccessResponse(true));
});

app.MapPost("/api/caption/get", async Task<IResult> (HttpRequest request, ToolkitRepository repo, CancellationToken cancellationToken) =>
{
    var payload = await request.ReadFromJsonAsync(AppJsonSerializerContext.Default.CaptionGetRequest, cancellationToken);
    if (payload is null || string.IsNullOrWhiteSpace(payload.ImgPath))
    {
        return Results.Text(string.Empty, "text/plain; charset=utf-8");
    }

    var settings = await repo.GetSettingsAsync();
    if (!ApiHelpers.IsAllowedFilePath(payload.ImgPath, new[] { settings.DatasetsFolder }))
    {
        return Results.Text("Access denied", statusCode: StatusCodes.Status403Forbidden);
    }

    var captionPath = Path.ChangeExtension(payload.ImgPath, ".txt");
    if (captionPath is null || !File.Exists(captionPath))
    {
        return Results.Text(string.Empty, "text/plain; charset=utf-8");
    }

    var caption = await File.ReadAllTextAsync(captionPath, cancellationToken);
    return Results.Text(caption, "text/plain; charset=utf-8");
});

app.MapPost("/api/zip", async Task<IResult> (HttpRequest request, JobManager jobManager, CancellationToken cancellationToken) =>
{
    var payload = await request.ReadFromJsonAsync(AppJsonSerializerContext.Default.ZipRequest, cancellationToken);
    if (payload is null || string.IsNullOrWhiteSpace(payload.JobName))
    {
        return ApiHelpers.Error("jobName is required", StatusCodes.Status400BadRequest);
    }

    if (!string.Equals(payload.ZipTarget, "samples", StringComparison.OrdinalIgnoreCase))
    {
        return ApiHelpers.Error("Only samples zip is supported", StatusCodes.Status400BadRequest);
    }

    var zipPath = await jobManager.CreateSamplesZipAsync(payload.JobName);
    if (string.IsNullOrWhiteSpace(zipPath))
    {
        return ApiHelpers.Error("Folder not found", StatusCodes.Status404NotFound);
    }

    return Results.Ok(new ZipResponse(true, zipPath, Path.GetFileName(zipPath)));
});

app.MapGet("/api/gpu", async () => Results.Ok(await SystemInfoHelpers.ReadGpuInfoAsync()));

app.MapGet("/api/cpu", (CpuUsageTracker tracker) => Results.Ok(SystemInfoHelpers.ReadCpuInfo(tracker)));

app.MapGet("/api/img/{**imagePath}", async Task<IResult> (string imagePath, ToolkitRepository repo) =>
{
    var settings = await repo.GetSettingsAsync();
    var decodedPath = ApiHelpers.DecodeRoutePath(imagePath);
    if (!ApiHelpers.IsAllowedFilePath(decodedPath, new[] { settings.DatasetsFolder, settings.TrainingFolder, settings.DataRoot }))
    {
        return Results.Text("Access denied", statusCode: StatusCodes.Status403Forbidden);
    }

    if (!File.Exists(decodedPath))
    {
        return Results.Text("File not found", statusCode: StatusCodes.Status404NotFound);
    }

    if (!contentTypeProvider.TryGetContentType(decodedPath, out var contentType))
    {
        contentType = "application/octet-stream";
    }

    return TypedResults.PhysicalFile(decodedPath, contentType, enableRangeProcessing: true);
});

app.MapGet("/api/files/{**filePath}", async Task<IResult> (string filePath, ToolkitRepository repo) =>
{
    var settings = await repo.GetSettingsAsync();
    var decodedPath = ApiHelpers.DecodeRoutePath(filePath);
    if (!ApiHelpers.IsAllowedFilePath(decodedPath, new[] { settings.DatasetsFolder, settings.TrainingFolder, settings.DataRoot }))
    {
        return Results.Text("Access denied", statusCode: StatusCodes.Status403Forbidden);
    }

    if (!File.Exists(decodedPath))
    {
        return Results.Text("File not found", statusCode: StatusCodes.Status404NotFound);
    }

    if (!contentTypeProvider.TryGetContentType(decodedPath, out var contentType))
    {
        contentType = "application/octet-stream";
    }

    return TypedResults.PhysicalFile(decodedPath, contentType, fileDownloadName: Path.GetFileName(decodedPath), enableRangeProcessing: true);
});

app.MapFallbackToFile("index.html");

app.Run();

internal sealed record ParsedJobSaveRequest(string? Id, string? Name, string? GpuIds, string? JobConfig, string? Error)
{
    public bool IsValid => Error is null && !string.IsNullOrWhiteSpace(Name) && !string.IsNullOrWhiteSpace(JobConfig);
}

internal static class ApiHelpers
{
    private static readonly HashSet<string> MediaExtensions = new(StringComparer.OrdinalIgnoreCase)
    {
        ".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif", ".tiff", ".mp4", ".avi", ".mov", ".mkv", ".wmv", ".m4v", ".flv", ".mp3", ".wav"
    };

    public static ParsedJobSaveRequest ParseJobSaveRequest(JsonElement root)
    {
        if (root.ValueKind != JsonValueKind.Object)
        {
            return new ParsedJobSaveRequest(null, null, null, null, "Request body must be a JSON object");
        }

        var id = TryReadString(root, "id");
        var name = TryReadString(root, "name");
        var gpuIds = TryReadString(root, "gpuIds", "gpu_ids");
        var jobConfigElement = TryGetProperty(root, "jobConfig", "job_config");
        var jobConfig = jobConfigElement.HasValue
            ? jobConfigElement.Value.ValueKind == JsonValueKind.String
                ? jobConfigElement.Value.GetString()
                : jobConfigElement.Value.GetRawText()
            : null;

        if (string.IsNullOrWhiteSpace(name))
        {
            return new ParsedJobSaveRequest(id, null, gpuIds, jobConfig, "Job name is required");
        }

        if (string.IsNullOrWhiteSpace(jobConfig))
        {
            return new ParsedJobSaveRequest(id, name, gpuIds, null, "jobConfig is required");
        }

        return new ParsedJobSaveRequest(NullIfWhiteSpace(id), name.Trim(), NullIfWhiteSpace(gpuIds), jobConfig, null);
    }

    public static async Task EnsureQueuesForCurrentHardwareAsync(ToolkitRepository repo)
    {
        var jobs = await repo.GetJobsAsync();
        foreach (var gpuIds in jobs.Select(job => job.GpuIds).Where(value => !string.IsNullOrWhiteSpace(value)).Distinct(StringComparer.OrdinalIgnoreCase))
        {
            await repo.EnsureQueueAsync(gpuIds, false);
        }

        var gpuInfo = await SystemInfoHelpers.ReadGpuInfoAsync();
        if (gpuInfo.IsMac)
        {
            await repo.EnsureQueueAsync("mps", false);
        }

        foreach (var gpu in gpuInfo.Gpus)
        {
            await repo.EnsureQueueAsync(gpu.Index.ToString(CultureInfo.InvariantCulture), false);
        }
    }

    public static IResult Error(string message, int statusCode)
    {
        return TypedResults.Json(new ErrorResponse(message), AppJsonSerializerContext.Default.ErrorResponse, statusCode: statusCode);
    }
    public static string[] FindMediaFilesRecursively(string directory)
    {
        var results = new List<string>();
        foreach (var entry in Directory.EnumerateFileSystemEntries(directory))
        {
            var name = Path.GetFileName(entry);
            if (string.IsNullOrWhiteSpace(name) || name.StartsWith('.'))
            {
                continue;
            }

            if (Directory.Exists(entry))
            {
                if (!string.Equals(name, "_controls", StringComparison.OrdinalIgnoreCase))
                {
                    results.AddRange(FindMediaFilesRecursively(entry));
                }

                continue;
            }

            if (MediaExtensions.Contains(Path.GetExtension(entry)))
            {
                results.Add(entry);
            }
        }

        results.Sort(StringComparer.OrdinalIgnoreCase);
        return results.ToArray();
    }

    public static string SanitizeDatasetName(string name)
    {
        var builder = new System.Text.StringBuilder(name.Length);
        var lastWasUnderscore = false;
        foreach (var ch in name.Trim().ToLowerInvariant())
        {
            if (ch is >= 'a' and <= 'z' or >= '0' and <= '9')
            {
                builder.Append(ch);
                lastWasUnderscore = false;
            }
            else if (!lastWasUnderscore)
            {
                builder.Append('_');
                lastWasUnderscore = true;
            }
        }

        return builder.ToString().Trim('_');
    }

    public static string SanitizeUploadedFileName(string fileName)
    {
        var invalidChars = Path.GetInvalidFileNameChars();
        var builder = new System.Text.StringBuilder(fileName.Length);
        foreach (var ch in fileName)
        {
            builder.Append(invalidChars.Contains(ch) || ch == '/' || ch == '\\' ? '_' : ch);
        }

        var cleaned = builder.ToString();
        return string.IsNullOrWhiteSpace(cleaned) ? Guid.NewGuid().ToString("N") : cleaned;
    }

    public static async Task SaveFormFileAsync(IFormFile formFile, string destinationPath, CancellationToken cancellationToken)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(destinationPath)!);
        await using var stream = File.Create(destinationPath);
        await formFile.CopyToAsync(stream, cancellationToken);
    }

    public static string ResolveChildPath(string root, string child)
    {
        var combined = Path.GetFullPath(Path.Combine(root, child));
        if (!ToolkitPaths.IsWithin(combined, root))
        {
            throw new InvalidOperationException("Resolved path escaped the configured root.");
        }

        return combined;
    }

    public static bool IsAllowedFilePath(string path, IEnumerable<string> allowedRoots)
    {
        if (string.IsNullOrWhiteSpace(path))
        {
            return false;
        }

        string fullPath;
        try
        {
            fullPath = Path.GetFullPath(path);
        }
        catch
        {
            return false;
        }

        return allowedRoots.Any(root => !string.IsNullOrWhiteSpace(root) && ToolkitPaths.IsWithin(fullPath, root));
    }

    public static string DecodeRoutePath(string routeValue)
    {
        return Uri.UnescapeDataString(routeValue ?? string.Empty);
    }

    public static int ReadInt(string value, int fallback, int min, int max)
    {
        if (!int.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out var parsed))
        {
            return fallback;
        }

        if (parsed < min)
        {
            return min;
        }

        return parsed > max ? max : parsed;
    }

    public static int? TryReadNullableInt(string value)
    {
        return int.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out var parsed) ? parsed : null;
    }

    private static string? TryReadString(JsonElement root, params string[] names)
    {
        var property = TryGetProperty(root, names);
        if (!property.HasValue || property.Value.ValueKind == JsonValueKind.Null)
        {
            return null;
        }

        return property.Value.ValueKind == JsonValueKind.String
            ? property.Value.GetString()
            : property.Value.GetRawText();
    }

    private static JsonElement? TryGetProperty(JsonElement root, params string[] names)
    {
        foreach (var property in root.EnumerateObject())
        {
            foreach (var name in names)
            {
                if (string.Equals(property.Name, name, StringComparison.OrdinalIgnoreCase))
                {
                    return property.Value;
                }
            }
        }

        return null;
    }

    private static string? NullIfWhiteSpace(string? value)
    {
        return string.IsNullOrWhiteSpace(value) ? null : value.Trim();
    }
}





