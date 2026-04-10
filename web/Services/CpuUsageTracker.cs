using System.Runtime.InteropServices;

namespace AiToolkit.Web;

public sealed class CpuUsageTracker
{
    private readonly object _sync = new();
    private ulong? _previousIdle;
    private ulong? _previousTotal;

    public double GetCurrentLoadPercent()
    {
        if (!OperatingSystem.IsWindows())
        {
            return 0;
        }

        if (!GetSystemTimes(out var idleTime, out var kernelTime, out var userTime))
        {
            return 0;
        }

        var idle = ToUInt64(idleTime);
        var total = ToUInt64(kernelTime) + ToUInt64(userTime);

        lock (_sync)
        {
            if (!_previousIdle.HasValue || !_previousTotal.HasValue)
            {
                _previousIdle = idle;
                _previousTotal = total;
                return 0;
            }

            var idleDelta = idle - _previousIdle.Value;
            var totalDelta = total - _previousTotal.Value;
            _previousIdle = idle;
            _previousTotal = total;

            if (totalDelta == 0)
            {
                return 0;
            }

            return Math.Clamp((1d - idleDelta / (double)totalDelta) * 100d, 0d, 100d);
        }
    }

    private static ulong ToUInt64(FILETIME time)
    {
        return ((ulong)time.dwHighDateTime << 32) | time.dwLowDateTime;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct FILETIME
    {
        public uint dwLowDateTime;
        public uint dwHighDateTime;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetSystemTimes(out FILETIME idleTime, out FILETIME kernelTime, out FILETIME userTime);
}
