namespace AiToolkit.Web;

public sealed record MetaResponse(bool AuthRequired, string Platform, string ToolkitRoot);

public sealed record AuthResponse(bool IsAuthenticated);

public sealed record ErrorResponse(string Error);

public sealed record SuccessResponse(bool Success);

public sealed record SettingsDto(string HfToken, string TrainingFolder, string DatasetsFolder, string DataRoot);

public sealed record SettingsUpdateRequest(string HfToken, string TrainingFolder, string DatasetsFolder, string DataRoot);

public sealed record SaveJobRequest(string? Id, string Name, string? GpuIds, string JobConfig);

public sealed record JobsResponse(JobDto[] Jobs);

public sealed record JobDto(
    string Id,
    string Name,
    string GpuIds,
    string JobConfig,
    string CreatedAt,
    string UpdatedAt,
    string Status,
    bool Stop,
    bool ReturnToQueue,
    int Step,
    string Info,
    string SpeedString,
    int QueuePosition,
    int? Pid);

public sealed class ToolkitJobUpdate
{
    public string? Name { get; init; }
    public string? GpuIds { get; init; }
    public string? JobConfig { get; init; }
    public string? Status { get; init; }
    public bool? Stop { get; init; }
    public bool? ReturnToQueue { get; init; }
    public int? Step { get; init; }
    public string? Info { get; init; }
    public string? SpeedString { get; init; }
    public int? QueuePosition { get; init; }
    public int? Pid { get; init; }
    public bool SetPidToNull { get; init; }
}

public sealed record QueueDto(int Id, string GpuIds, bool IsRunning);

public sealed record QueuesResponse(QueueDto[] Queues);

public sealed record DatasetListResponse(string[] Datasets);

public sealed record CreateDatasetRequest(string Name);

public sealed record DeleteDatasetRequest(string Name);

public sealed record DatasetCreateResponse(bool Success, string Name);

public sealed record ListImagesRequest(string DatasetName);

public sealed record DatasetImageItem(string ImgPath);

public sealed record DatasetImagesResponse(DatasetImageItem[] Images);

public sealed record UploadResponse(string Message, string[] Files);

public sealed record DeleteImageRequest(string ImgPath);

public sealed record CaptionRequest(string ImgPath, string Caption);

public sealed record CaptionGetRequest(string ImgPath);

public sealed record JobLogResponse(string Log);

public sealed record SamplesResponse(string[] Samples);

public sealed record FileEntryDto(string Path, long Size);

public sealed record JobFilesResponse(FileEntryDto[] Files);

public sealed record LossPointDto(int Step, double? WallTime, double? Value);

public sealed record LossResponse(string Key, string[] Keys, LossPointDto[] Points);

public sealed record ZipRequest(string ZipTarget, string JobName);

public sealed record ZipResponse(bool Ok, string ZipPath, string FileName);

public sealed record GpuResponse(bool HasNvidiaSmi, bool IsMac, GpuInfoDto[] Gpus, string? Error);

public sealed record GpuInfoDto(
    int Index,
    string Name,
    string DriverVersion,
    int Temperature,
    GpuUtilizationDto Utilization,
    GpuMemoryDto Memory,
    GpuPowerDto Power,
    GpuClocksDto Clocks,
    GpuFanDto Fan);

public sealed record GpuUtilizationDto(int Gpu, int Memory);

public sealed record GpuMemoryDto(long Total, long Free, long Used);

public sealed record GpuPowerDto(double Draw, double Limit);

public sealed record GpuClocksDto(int Graphics, int Memory);

public sealed record GpuFanDto(int Speed);

public sealed record CpuInfoDto(
    string Name,
    int Cores,
    int Temperature,
    long TotalMemory,
    long AvailableMemory,
    long FreeMemory,
    double CurrentLoad);
