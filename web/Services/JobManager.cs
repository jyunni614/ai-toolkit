using System.Collections.Concurrent;
using System.Diagnostics;
using System.IO.Compression;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Data.Sqlite;

namespace AiToolkit.Web;

public sealed class JobManager
{
    private static readonly UTF8Encoding Utf8NoBom = new(encoderShouldEmitUTF8Identifier: false);
    private readonly ToolkitRepository _repository;
    private readonly ToolkitPaths _paths;
    private readonly ILogger<JobManager> _logger;
    private readonly ConcurrentDictionary<string, Process> _processes = new();
    private readonly ConcurrentDictionary<string, string> _logCache = new();

    public JobManager(ToolkitRepository repository, ToolkitPaths paths, ILogger<JobManager> logger)
    {
        _repository = repository;
        _paths = paths;
        _logger = logger;
    }

    public static string SanitizeJobName(string name)
    {
        var trimmed = name.Trim();
        if (trimmed.Length == 0)
        {
            return "job";
        }

        var builder = new StringBuilder(trimmed.Length);
        foreach (var ch in trimmed)
        {
            builder.Append(char.IsLetterOrDigit(ch) || ch is '_' or '-' ? ch : '_');
        }

        var sanitized = builder.ToString().Trim('_');
        return sanitized.Length == 0 ? "job" : sanitized;
    }

    public string NormalizeJobConfig(string rawJobConfig, string name, SettingsDto settings)
    {
        var node = JsonNode.Parse(rawJobConfig) as JsonObject
            ?? throw new InvalidOperationException("The job config must be a JSON object.");

        if (node["config"] is not JsonObject config)
        {
            throw new InvalidOperationException("Missing config object.");
        }

        config["name"] = SanitizeJobName(name);

        if (config["process"] is not JsonArray processArray || processArray.Count == 0 || processArray[0] is not JsonObject process)
        {
            throw new InvalidOperationException("Missing config.process[0] object.");
        }

        process["training_folder"] = settings.TrainingFolder;
        process["sqlite_db_path"] = _paths.DatabasePath;
        process["performance_log_every"] = 10;
        process["device"] = OperatingSystem.IsMacOS() ? "mps" : "cuda";

        if (process["logging"] is not JsonObject logging)
        {
            logging = new JsonObject();
            process["logging"] = logging;
        }

        logging["log_every"] ??= 1;
        logging["use_ui_logger"] = true;

        return node.ToJsonString(new JsonSerializerOptions
        {
            WriteIndented = true
        });
    }

    public async Task RecoverRunningJobsAsync()
    {
        var jobs = await _repository.GetJobsAsync();
        foreach (var job in jobs.Where(job => job.Status is "running" or "stopping"))
        {
            if (job.Pid is int pid && !IsPidRunning(pid))
            {
                await FinalizeExitedJobAsync(job.Id, -1);
            }
        }
    }

    public async Task<bool> StartJobAsync(JobDto job, CancellationToken cancellationToken)
    {
        if (_processes.ContainsKey(job.Id))
        {
            return false;
        }

        var settings = await _repository.GetSettingsAsync();
        Directory.CreateDirectory(settings.TrainingFolder);

        var trainingFolder = GetJobFolder(settings, job.Name);
        Directory.CreateDirectory(trainingFolder);
        _logCache.TryRemove(job.Id, out _);
        RotateLog(trainingFolder);

        var normalizedConfig = NormalizeJobConfig(job.JobConfig, job.Name, settings);
        var configPath = Path.Combine(trainingFolder, ".job_config.json");
        var logPath = Path.Combine(trainingFolder, "log.txt");
        await File.WriteAllTextAsync(configPath, normalizedConfig, Utf8NoBom, cancellationToken);

        var pythonPath = ResolvePythonPath();
        var virtualEnvRoot = ResolveVirtualEnvRoot(pythonPath);
        var runPyPath = Path.Combine(_paths.ToolkitRoot, "run.py");
        if (!File.Exists(runPyPath))
        {
            await _repository.UpdateJobAsync(job.Id, new ToolkitJobUpdate
            {
                Status = "error",
                Info = "Error launching job: run.py not found"
            });
            return false;
        }

        var process = new Process
        {
            StartInfo = new ProcessStartInfo
            {
                FileName = pythonPath,
                WorkingDirectory = _paths.ToolkitRoot,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = false,
                RedirectStandardError = false,
            },
            EnableRaisingEvents = true
        };

        ConfigurePythonProcess(process.StartInfo, pythonPath, virtualEnvRoot);

        process.StartInfo.ArgumentList.Add(runPyPath);
        process.StartInfo.ArgumentList.Add(configPath);
        process.StartInfo.ArgumentList.Add("--log");
        process.StartInfo.ArgumentList.Add(logPath);
        process.StartInfo.Environment["AITK_JOB_ID"] = job.Id;
        process.StartInfo.Environment["IS_AI_TOOLKIT_UI"] = "1";

        if (!OperatingSystem.IsMacOS() && !string.Equals(job.GpuIds, "mps", StringComparison.OrdinalIgnoreCase))
        {
            process.StartInfo.Environment["CUDA_DEVICE_ORDER"] = "PCI_BUS_ID";
            process.StartInfo.Environment["CUDA_VISIBLE_DEVICES"] = job.GpuIds;
        }

        if (!string.IsNullOrWhiteSpace(settings.HfToken))
        {
            process.StartInfo.Environment["HF_TOKEN"] = settings.HfToken;
        }

        try
        {
            process.Start();
            _processes[job.Id] = process;

            process.Exited += (_, _) =>
            {
                _ = Task.Run(async () =>
                {
                    try
                    {
                        await FinalizeExitedJobAsync(job.Id, process.ExitCode);
                    }
                    catch (Exception ex)
                    {
                        _logger.LogError(ex, "Failed to finalize job {JobId}", job.Id);
                    }
                    finally
                    {
                        process.Dispose();
                    }
                });
            };

            await _repository.UpdateJobAsync(job.Id, new ToolkitJobUpdate
            {
                Status = "running",
                Stop = false,
                ReturnToQueue = false,
                Info = "Running job...",
                Pid = process.Id
            });

            await File.WriteAllTextAsync(Path.Combine(trainingFolder, "pid.txt"), process.Id.ToString(), Utf8NoBom, cancellationToken);
            return true;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to start job {JobId}", job.Id);
            await _repository.UpdateJobAsync(job.Id, new ToolkitJobUpdate
            {
                Status = "error",
                Info = $"Error launching job: {ex.Message}"
            });
            return false;
        }
    }

    public async Task RequestStopAsync(JobDto job, bool requeue)
    {
        await _repository.UpdateJobAsync(job.Id, new ToolkitJobUpdate
        {
            Status = "stopping",
            Stop = true,
            ReturnToQueue = requeue,
            Info = requeue ? "Stopping job and returning it to queue..." : "Stopping job..."
        });

        if (_processes.TryGetValue(job.Id, out var process))
        {
            TryKillProcessTree(process.Id);
            return;
        }

        if (job.Pid.HasValue)
        {
            TryKillProcessTree(job.Pid.Value);
            return;
        }

        await FinalizeExitedJobAsync(job.Id, -1);
    }

    public async Task RefreshRuntimeAsync(JobDto job)
    {
        if (job.Status is "running" or "stopping")
        {
            var maxStep = await ReadMaxLossStepAsync(job);
            if (maxStep > job.Step)
            {
                await _repository.UpdateJobAsync(job.Id, new ToolkitJobUpdate
                {
                    Step = maxStep,
                    Info = job.Status == "stopping" ? "Stopping job..." : "Running job..."
                });
            }
        }

        if (job.Status is "running" or "stopping")
        {
            var trackedRunning = _processes.TryGetValue(job.Id, out var process) && !process.HasExited;
            var pidRunning = job.Pid.HasValue && IsPidRunning(job.Pid.Value);
            if (!trackedRunning && !pidRunning)
            {
                await FinalizeExitedJobAsync(job.Id, -1);
            }
        }
    }

    public async Task DeleteJobArtifactsAsync(JobDto job)
    {
        _logCache.TryRemove(job.Id, out _);

        var settings = await _repository.GetSettingsAsync();
        var jobFolder = GetJobFolder(settings, job.Name);
        if (Directory.Exists(jobFolder))
        {
            Directory.Delete(jobFolder, recursive: true);
        }
    }

    public async Task<string> ReadLogAsync(JobDto job)
    {
        var settings = await _repository.GetSettingsAsync();
        var logPath = Path.Combine(GetJobFolder(settings, job.Name), "log.txt");
        if (!File.Exists(logPath))
        {
            return _logCache.TryGetValue(job.Id, out var cachedMissing) ? cachedMissing : string.Empty;
        }

        try
        {
            var content = NormalizeConsoleLog(await ReadSharedTextAsync(logPath));
            _logCache[job.Id] = content;
            return content;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            if (_logCache.TryGetValue(job.Id, out var cached))
            {
                _logger.LogDebug(ex, "Log file busy for job {JobId}, using cached log content", job.Id);
                return cached;
            }

            _logger.LogWarning(ex, "Log file busy for job {JobId}, returning empty log content", job.Id);
            return string.Empty;
        }
    }

    public async Task<IReadOnlyList<string>> GetSamplesAsync(JobDto job)
    {
        var settings = await _repository.GetSettingsAsync();
        var samplesFolder = Path.Combine(GetJobFolder(settings, job.Name), "samples");
        if (!Directory.Exists(samplesFolder))
        {
            return Array.Empty<string>();
        }

        return Directory.GetFiles(samplesFolder)
            .Where(IsSupportedSampleFile)
            .OrderBy(path => path, StringComparer.OrdinalIgnoreCase)
            .ToArray();
    }

    public async Task<IReadOnlyList<FileEntryDto>> GetModelFilesAsync(JobDto job)
    {
        var settings = await _repository.GetSettingsAsync();
        var jobFolder = GetJobFolder(settings, job.Name);
        if (!Directory.Exists(jobFolder))
        {
            return Array.Empty<FileEntryDto>();
        }

        return Directory.GetFiles(jobFolder, "*.safetensors", SearchOption.TopDirectoryOnly)
            .Select(path => new FileEntryDto(path, new FileInfo(path).Length))
            .OrderBy(item => item.Path, StringComparer.OrdinalIgnoreCase)
            .ToArray();
    }

    public async Task<LossResponse> ReadLossAsync(JobDto job, string key, int limit, int? sinceStep, int stride)
    {
        var settings = await _repository.GetSettingsAsync();
        var lossDbPath = Path.Combine(GetJobFolder(settings, job.Name), "loss_log.db");
        if (!File.Exists(lossDbPath))
        {
            return new LossResponse(key, Array.Empty<string>(), Array.Empty<LossPointDto>());
        }

        await using var connection = new SqliteConnection(new SqliteConnectionStringBuilder
        {
            DataSource = lossDbPath,
            Mode = SqliteOpenMode.ReadOnly
        }.ToString());
        await connection.OpenAsync();

        await using var keysCommand = connection.CreateCommand();
        keysCommand.CommandText = "SELECT key FROM metric_keys ORDER BY key ASC;";
        await using var keyReader = await keysCommand.ExecuteReaderAsync();
        var keys = new List<string>();
        while (await keyReader.ReadAsync())
        {
            keys.Add(keyReader.GetString(0));
        }

        await using var pointsCommand = connection.CreateCommand();
        pointsCommand.CommandText =
            """
            SELECT
                m.step AS step,
                s.wall_time AS wall_time,
                m.value_real AS value,
                m.value_text AS value_text
            FROM metrics m
            JOIN steps s ON s.step = m.step
            WHERE m.key = $key
              AND ($sinceStep IS NULL OR m.step > $sinceStep)
              AND (m.step % $stride) = 0
            ORDER BY m.step ASC
            LIMIT $limit;
            """;
        pointsCommand.Parameters.AddWithValue("$key", key);
        pointsCommand.Parameters.AddWithValue("$sinceStep", sinceStep.HasValue ? sinceStep.Value : DBNull.Value);
        pointsCommand.Parameters.AddWithValue("$stride", stride);
        pointsCommand.Parameters.AddWithValue("$limit", limit);
        await using var reader = await pointsCommand.ExecuteReaderAsync();
        var points = new List<LossPointDto>();
        while (await reader.ReadAsync())
        {
            double? value = null;
            if (!reader.IsDBNull(2))
            {
                value = reader.GetDouble(2);
            }
            else if (!reader.IsDBNull(3) && double.TryParse(reader.GetString(3), out var parsed))
            {
                value = parsed;
            }

            points.Add(new LossPointDto(reader.GetInt32(0), reader.GetDouble(1), value));
        }

        return new LossResponse(key, keys.ToArray(), points.ToArray());
    }

    public async Task<string?> CreateSamplesZipAsync(string jobName)
    {
        var settings = await _repository.GetSettingsAsync();
        var samplesFolder = Path.Combine(GetJobFolder(settings, jobName), "samples");
        if (!Directory.Exists(samplesFolder))
        {
            return null;
        }

        var outputPath = Path.Combine(GetJobFolder(settings, jobName), "samples.zip");
        if (File.Exists(outputPath))
        {
            File.Delete(outputPath);
        }

        ZipFile.CreateFromDirectory(samplesFolder, outputPath, CompressionLevel.SmallestSize, includeBaseDirectory: true);
        return outputPath;
    }

    private async Task<string> ReadSharedTextAsync(string path)
    {
        const int maxAttempts = 3;
        for (var attempt = 0; attempt < maxAttempts; attempt++)
        {
            try
            {
                await using var stream = new FileStream(
                    path,
                    FileMode.Open,
                    FileAccess.Read,
                    FileShare.ReadWrite | FileShare.Delete,
                    bufferSize: 4096,
                    options: FileOptions.Asynchronous | FileOptions.SequentialScan);
                using var reader = new StreamReader(stream, Encoding.UTF8, detectEncodingFromByteOrderMarks: true);
                return await reader.ReadToEndAsync();
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                if (attempt == maxAttempts - 1)
                {
                    throw;
                }

                await Task.Delay(40 * (attempt + 1));
            }
        }

        return string.Empty;
    }

    private static string NormalizeConsoleLog(string content)
    {
        if (string.IsNullOrEmpty(content))
        {
            return string.Empty;
        }

        var output = new StringBuilder(content.Length);
        var currentLine = new StringBuilder();
        var inEscapeSequence = false;

        static void FlushLine(StringBuilder destination, StringBuilder line)
        {
            destination.Append(line);
            destination.Append('\n');
            line.Clear();
        }

        for (var index = 0; index < content.Length; index++)
        {
            var ch = content[index];

            if (inEscapeSequence)
            {
                if (ch >= '@' && ch <= '~')
                {
                    inEscapeSequence = false;
                }
                continue;
            }

            if (ch == '\u001b')
            {
                inEscapeSequence = true;
                continue;
            }

            if (ch == '\r')
            {
                if (index + 1 < content.Length && content[index + 1] == '\n')
                {
                    FlushLine(output, currentLine);
                    index++;
                }
                else
                {
                    currentLine.Clear();
                }
                continue;
            }

            if (ch == '\n')
            {
                FlushLine(output, currentLine);
                continue;
            }

            if (ch == '\b')
            {
                if (currentLine.Length > 0)
                {
                    currentLine.Length -= 1;
                }
                continue;
            }

            if (ch == '\0')
            {
                continue;
            }

            currentLine.Append(ch);
        }

        output.Append(currentLine);
        return output.ToString();
    }

    private async Task<int> ReadMaxLossStepAsync(JobDto job)
    {
        var settings = await _repository.GetSettingsAsync();
        var lossDbPath = Path.Combine(GetJobFolder(settings, job.Name), "loss_log.db");
        if (!File.Exists(lossDbPath))
        {
            return job.Step;
        }

        await using var connection = new SqliteConnection(new SqliteConnectionStringBuilder
        {
            DataSource = lossDbPath,
            Mode = SqliteOpenMode.ReadOnly
        }.ToString());
        await connection.OpenAsync();
        await using var command = connection.CreateCommand();
        command.CommandText = "SELECT COALESCE(MAX(step), 0) FROM steps;";
        var result = await command.ExecuteScalarAsync();
        return result is null or DBNull ? job.Step : Convert.ToInt32(result);
    }

    private async Task FinalizeExitedJobAsync(string jobId, int exitCode)
    {
        if (_processes.TryRemove(jobId, out var process))
        {
            process.Dispose();
        }

        var job = await _repository.GetJobAsync(jobId);
        if (job is null)
        {
            return;
        }

        var refreshedStep = await ReadMaxLossStepAsync(job);
        if (refreshedStep > job.Step)
        {
            await _repository.UpdateJobAsync(job.Id, new ToolkitJobUpdate
            {
                Step = refreshedStep
            });
        }

        job = await _repository.GetJobAsync(jobId) ?? job;

        if (job.ReturnToQueue)
        {
            await _repository.UpdateJobAsync(job.Id, new ToolkitJobUpdate
            {
                Status = "queued",
                Stop = false,
                ReturnToQueue = false,
                Info = "Job returned to queue",
                SetPidToNull = true
            });
            return;
        }

        if (job.Stop)
        {
            await _repository.UpdateJobAsync(job.Id, new ToolkitJobUpdate
            {
                Status = "stopped",
                Stop = false,
                Info = "Job stopped",
                SetPidToNull = true
            });
            return;
        }

        await _repository.UpdateJobAsync(job.Id, new ToolkitJobUpdate
        {
            Status = exitCode == 0 ? "completed" : "error",
            Info = exitCode == 0 ? "Job completed" : $"Job failed with exit code {exitCode}",
            SetPidToNull = true
        });
    }

    private string ResolvePythonPath()
    {
        var dotVenv = OperatingSystem.IsWindows()
            ? Path.Combine(_paths.ToolkitRoot, ".venv", "Scripts", "python.exe")
            : Path.Combine(_paths.ToolkitRoot, ".venv", "bin", "python");
        if (File.Exists(dotVenv))
        {
            return dotVenv;
        }

        var venv = OperatingSystem.IsWindows()
            ? Path.Combine(_paths.ToolkitRoot, "venv", "Scripts", "python.exe")
            : Path.Combine(_paths.ToolkitRoot, "venv", "bin", "python");
        if (File.Exists(venv))
        {
            return venv;
        }

        return "python";
    }

    private static string? ResolveVirtualEnvRoot(string pythonPath)
    {
        if (string.IsNullOrWhiteSpace(pythonPath) || !Path.IsPathRooted(pythonPath))
        {
            return null;
        }

        try
        {
            var fullPath = Path.GetFullPath(pythonPath);
            if (!File.Exists(fullPath))
            {
                return null;
            }

            var scriptsDirectory = Path.GetDirectoryName(fullPath);
            if (scriptsDirectory is null)
            {
                return null;
            }

            var parent = Directory.GetParent(scriptsDirectory);
            if (parent is null)
            {
                return null;
            }

            var candidate = parent.FullName;
            return Directory.Exists(candidate) ? candidate : null;
        }
        catch
        {
            return null;
        }
    }

    private static void ConfigurePythonProcess(ProcessStartInfo startInfo, string pythonPath, string? virtualEnvRoot)
    {
        startInfo.Environment["PYTHONUTF8"] = "1";
        startInfo.Environment["PYTHONIOENCODING"] = "utf-8";

        if (string.IsNullOrWhiteSpace(virtualEnvRoot))
        {
            return;
        }

        startInfo.Environment["VIRTUAL_ENV"] = virtualEnvRoot;

        var scriptsDirectory = Path.GetDirectoryName(pythonPath);
        if (string.IsNullOrWhiteSpace(scriptsDirectory))
        {
            return;
        }

        var existingPath = startInfo.Environment.TryGetValue("PATH", out var currentPath)
            ? currentPath
            : Environment.GetEnvironmentVariable("PATH") ?? string.Empty;

        startInfo.Environment["PATH"] = string.IsNullOrWhiteSpace(existingPath)
            ? scriptsDirectory
            : scriptsDirectory + Path.PathSeparator + existingPath;
    }

    private static string GetJobFolder(SettingsDto settings, string jobName)
    {
        var folder = Path.GetFullPath(Path.Combine(settings.TrainingFolder, jobName));
        if (!ToolkitPaths.IsWithin(folder, settings.TrainingFolder))
        {
            throw new InvalidOperationException("Resolved training folder escaped the configured training root.");
        }

        return folder;
    }

    private static void RotateLog(string trainingFolder)
    {
        var logPath = Path.Combine(trainingFolder, "log.txt");
        if (!File.Exists(logPath))
        {
            return;
        }

        var logsFolder = Path.Combine(trainingFolder, "logs");
        Directory.CreateDirectory(logsFolder);
        var index = 0;
        string target;
        do
        {
            target = Path.Combine(logsFolder, $"{index}_log.txt");
            index++;
        } while (File.Exists(target));

        File.Move(logPath, target);
    }

    private static bool TryKillProcessTree(int pid)
    {
        try
        {
            if (OperatingSystem.IsWindows())
            {
                using var process = Process.Start(new ProcessStartInfo
                {
                    FileName = "taskkill",
                    Arguments = $"/PID {pid} /T /F",
                    UseShellExecute = false,
                    CreateNoWindow = true
                });
                process?.WaitForExit(5000);
                return true;
            }

            Process.Start("kill", $"-INT {pid}")?.WaitForExit(5000);
            return true;
        }
        catch
        {
            return false;
        }
    }

    private static bool IsPidRunning(int pid)
    {
        try
        {
            using var process = Process.GetProcessById(pid);
            return !process.HasExited;
        }
        catch
        {
            return false;
        }
    }

    private static bool IsSupportedSampleFile(string path)
    {
        var ext = Path.GetExtension(path).ToLowerInvariant();
        return ext is ".png" or ".jpg" or ".jpeg" or ".webp" or ".mp4" or ".mp3" or ".wav";
    }
}








