using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;

namespace ExamGuard.Agent;

/// <summary>The foreground window's process. Window titles are never read.</summary>
public sealed record ForegroundSample(string? ProcessName, int? ProcessId);

public interface IForegroundReader
{
    /// <summary>Returns null when no window has the foreground, as during a switch.</summary>
    ForegroundSample? Read();
}

public sealed partial class Win32ForegroundReader : IForegroundReader
{
    [LibraryImport("user32.dll")]
    private static partial IntPtr GetForegroundWindow();

    [LibraryImport("user32.dll")]
    private static partial uint GetWindowThreadProcessId(IntPtr window, out uint processId);

    public ForegroundSample? Read()
    {
        var window = GetForegroundWindow();
        if (window == IntPtr.Zero)
        {
            return null;
        }

        if (GetWindowThreadProcessId(window, out var processId) == 0 || processId == 0)
        {
            return new ForegroundSample(null, null);
        }

        var id = (int)processId;
        try
        {
            using var process = Process.GetProcessById(id);
            return new ForegroundSample(process.ProcessName, id);
        }
        catch (Exception error) when (error is ArgumentException or InvalidOperationException or Win32Exception)
        {
            return new ForegroundSample(null, id);
        }
    }
}
