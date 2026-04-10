using System.Text.Json.Serialization;

namespace AiToolkit.Web;

[JsonSourceGenerationOptions(
    PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase,
    DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull)]
[JsonSerializable(typeof(AuthResponse))]
[JsonSerializable(typeof(CaptionGetRequest))]
[JsonSerializable(typeof(CaptionRequest))]
[JsonSerializable(typeof(CpuInfoDto))]
[JsonSerializable(typeof(CreateDatasetRequest))]
[JsonSerializable(typeof(DatasetCreateResponse))]
[JsonSerializable(typeof(DatasetImagesResponse))]
[JsonSerializable(typeof(DatasetListResponse))]
[JsonSerializable(typeof(DeleteDatasetRequest))]
[JsonSerializable(typeof(DeleteImageRequest))]
[JsonSerializable(typeof(ErrorResponse))]
[JsonSerializable(typeof(GpuResponse))]
[JsonSerializable(typeof(JobDto))]
[JsonSerializable(typeof(JobFilesResponse))]
[JsonSerializable(typeof(JobLogResponse))]
[JsonSerializable(typeof(JobsResponse))]
[JsonSerializable(typeof(ListImagesRequest))]
[JsonSerializable(typeof(LossResponse))]
[JsonSerializable(typeof(MetaResponse))]
[JsonSerializable(typeof(QueuesResponse))]
[JsonSerializable(typeof(SamplesResponse))]
[JsonSerializable(typeof(SaveJobRequest))]
[JsonSerializable(typeof(SettingsDto))]
[JsonSerializable(typeof(SettingsUpdateRequest))]
[JsonSerializable(typeof(SuccessResponse))]
[JsonSerializable(typeof(UploadResponse))]
[JsonSerializable(typeof(ZipRequest))]
[JsonSerializable(typeof(ZipResponse))]
internal partial class AppJsonSerializerContext : JsonSerializerContext
{
}
