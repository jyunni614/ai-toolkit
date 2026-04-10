using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32;

namespace AiToolkit.Web;

internal static class SystemInfoHelpers
{
    public static string GetPlatformName()
    {
        if (OperatingSystem.IsWindows())
        {
            return "win32";
        }

        if (OperatingSystem.IsMacOS())
        {
            return "darwin";
        }

        if (OperatingSystem.IsLinux())
        {
            return "linux";
        }

        return RuntimeInformation.OSDescription;
    }

    public static async Task<GpuResponse> ReadGpuInfoAsync()
    {
        if (OperatingSystem.IsMacOS())
        {
            var totalMb = Math.Round(GC.GetGCMemoryInfo().TotalAvailableMemoryBytes / 1024d / 1024d);
            return new GpuResponse(
                false,
                true,
                new[]
                {
                    new GpuInfoDto(
                        0,
                        "Apple GPU",
                        "macOS",
                        0,
                        new GpuUtilizationDto(0, 0),
                        new GpuMemoryDto((long) totalMb, 0, 0),
                        new GpuPowerDto(0, 0),
                        new GpuClocksDto(0, 0),
                        new GpuFanDto(0))
                },
                null);
        }

        var exists = await RunCommandCaptureAsync("nvidia-smi", "-L");
        if (exists.ExitCode != 0)
        {
            return new GpuResponse(false, false, Array.Empty<GpuInfoDto>(), "nvidia-smi not found or not accessible");
        }

        var output = await RunCommandCaptureAsync(
            "nvidia-smi",
            "--query-gpu=index,name,driver_version,temperature.gpu,utilization.gpu,utilization.memory,memory.total,memory.free,memory.used,power.draw,power.limit,clocks.current.graphics,clocks.current.memory,fan.speed --format=csv,noheader,nounits");
        if (output.ExitCode != 0)
        {
            return new GpuResponse(false, false, Array.Empty<GpuInfoDto>(), output.Output.Trim());
        }

        var gpus = output.Output
            .Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(ParseGpuLine)
            .Where(gpu => gpu is not null)
            .Cast<GpuInfoDto>()
            .OrderBy(gpu => gpu.Index)
            .ToArray();

        return new GpuResponse(true, false, gpus, null);
    }

    public static CpuInfoDto ReadCpuInfo(CpuUsageTracker tracker)
    {
        if (OperatingSystem.IsWindows() && TryGetWindowsMemoryInfo(out var totalPhysical, out var availablePhysical))
        {
            return new CpuInfoDto(
                GetCpuName(),
                Environment.ProcessorCount,
                0,
                (long)Math.Round(totalPhysical / 1024d / 1024d),
                (long)Math.Round(availablePhysical / 1024d / 1024d),
                (long)Math.Round(availablePhysical / 1024d / 1024d),
                tracker.GetCurrentLoadPercent());
        }

        var totalAvailable = GC.GetGCMemoryInfo().TotalAvailableMemoryBytes;
        return new CpuInfoDto(
            GetCpuName(),
            Environment.ProcessorCount,
            0,
            (long)Math.Round(totalAvailable / 1024d / 1024d),
            0,
            0,
            tracker.GetCurrentLoadPercent());
    }

    private static GpuInfoDto? ParseGpuLine(string line)
    {
        var parts = line.Split(", ", StringSplitOptions.None);
        if (parts.Length < 14)
        {
            return null;
        }

        return new GpuInfoDto(
            ParseInt(parts[0]),
            parts[1],
            parts[2],
            ParseInt(parts[3]),
            new GpuUtilizationDto(ParseInt(parts[4]), ParseInt(parts[5])),
            new GpuMemoryDto(ParseLong(parts[6]), ParseLong(parts[7]), ParseLong(parts[8])),
            new GpuPowerDto(ParseDouble(parts[9]), ParseDouble(parts[10])),
            new GpuClocksDto(ParseInt(parts[11]), ParseInt(parts[12])),
            new GpuFanDto(ParseInt(parts[13])));
    }

    private static int ParseInt(string value)
    {
        return int.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out var parsed) ? parsed : 0;
    }

    private static long ParseLong(string value)
    {
        return long.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out var parsed) ? parsed : 0;
    }

    private static double ParseDouble(string value)
    {
        return double.TryParse(value, NumberStyles.Float, CultureInfo.InvariantCulture, out var parsed) ? parsed : 0;
    }

    private static string GetCpuName()
    {
        if (OperatingSystem.IsWindows())
        {
            try
            {
                return Registry.GetValue(
                    @"HKEY_LOCAL_MACHINE\HARDWARE\DESCRIPTION\System\CentralProcessor\0",
                    "ProcessorNameString",
                    null)?.ToString()?.Trim() ?? RuntimeInformation.OSDescription;
            }
            catch
            {
                return RuntimeInformation.OSDescription;
            }
        }

        return RuntimeInformation.OSDescription;
    }

    private static bool TryGetWindowsMemoryInfo(out ulong totalPhysical, out ulong availablePhysical)
    {
        var status = new MEMORYSTATUSEX { dwLength = (uint)Marshal.SizeOf<MEMORYSTATUSEX>() };
        if (GlobalMemoryStatusEx(ref status))
        {
            totalPhysical = status.ullTotalPhys;
            availablePhysical = status.ullAvailPhys;
            return true;
        }

        totalPhysical = 0;
        availablePhysical = 0;
        return false;
    }

    private static async Task<CommandResult> RunCommandCaptureAsync(string fileName, string arguments)
    {
        var process = new Process
        {
            StartInfo = new ProcessStartInfo
            {
                FileName = fileName,
                Arguments = arguments,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true,
            }
        };

        var output = new StringBuilder();
        process.OutputDataReceived += (_, args) =>
        {
            if (args.Data is not null)
            {
                output.AppendLine(args.Data);
            }
        };
        process.ErrorDataReceived += (_, args) =>
        {
            if (args.Data is not null)
            {
                output.AppendLine(args.Data);
            }
        };

        try
        {
            process.Start();
            process.BeginOutputReadLine();
            process.BeginErrorReadLine();
            await process.WaitForExitAsync();
            return new CommandResult(process.ExitCode, output.ToString());
        }
        catch (Exception ex)
        {
            return new CommandResult(-1, ex.Message);
        }
        finally
        {
            process.Dispose();
        }
    }

    private sealed record CommandResult(int ExitCode, string Output);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Auto)]
    private struct MEMORYSTATUSEX
    {
        public uint dwLength;
        public uint dwMemoryLoad;
        public ulong ullTotalPhys;
        public ulong ullAvailPhys;
        public ulong ullTotalPageFile;
        public ulong ullAvailPageFile;
        public ulong ullTotalVirtual;
        public ulong ullAvailVirtual;
        public ulong ullAvailExtendedVirtual;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    private static extern bool GlobalMemoryStatusEx(ref MEMORYSTATUSEX lpBuffer);
}



