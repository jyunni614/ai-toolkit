namespace AiToolkit.Web;

public sealed class ToolkitPaths
{
    public ToolkitPaths(IHostEnvironment environment)
    {
        ToolkitRoot = ResolveToolkitRoot(environment.ContentRootPath);
        DatabasePath = Path.Combine(ToolkitRoot, "aitk_db.db");
        DefaultTrainingFolder = Path.Combine(ToolkitRoot, "output");
        DefaultDatasetsFolder = Path.Combine(ToolkitRoot, "datasets");
        DefaultDataRoot = Path.Combine(ToolkitRoot, "data");
    }

    public string ToolkitRoot { get; }
    public string DatabasePath { get; }
    public string DefaultTrainingFolder { get; }
    public string DefaultDatasetsFolder { get; }
    public string DefaultDataRoot { get; }

    public static bool IsWithin(string candidatePath, string allowedRoot)
    {
        var candidate = Path.GetFullPath(candidatePath)
            .TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        var root = Path.GetFullPath(allowedRoot)
            .TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);

        if (string.Equals(candidate, root, StringComparison.OrdinalIgnoreCase))
        {
            return true;
        }

        return candidate.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase);
    }

    public static string ResolveWebRootPath(string contentRootPath)
    {
        foreach (var start in GetStartDirectories(contentRootPath))
        {
            foreach (var candidate in EnumerateWebRootCandidates(start))
            {
                if (Directory.Exists(candidate))
                {
                    return candidate;
                }
            }
        }

        return Path.Combine(contentRootPath, "wwwroot");
    }

    private static string ResolveToolkitRoot(string contentRootPath)
    {
        foreach (var start in GetStartDirectories(contentRootPath))
        {
            var found = SearchUpForToolkitRoot(start);
            if (found is not null)
            {
                return found;
            }
        }

        return Path.GetFullPath(Path.Combine(contentRootPath, ".."));
    }

    private static IEnumerable<string> GetStartDirectories(string contentRootPath)
    {
        yield return contentRootPath;
        yield return AppContext.BaseDirectory;
        yield return Directory.GetCurrentDirectory();
    }

    private static IEnumerable<string> EnumerateWebRootCandidates(string start)
    {
        if (string.IsNullOrWhiteSpace(start))
        {
            yield break;
        }

        var directory = new DirectoryInfo(Path.GetFullPath(start));
        for (var depth = 0; directory is not null && depth < 8; depth++)
        {
            yield return Path.Combine(directory.FullName, "wwwroot");
            yield return Path.Combine(directory.FullName, "web", "wwwroot");
            directory = directory.Parent;
        }
    }

    private static string? SearchUpForToolkitRoot(string start)
    {
        if (string.IsNullOrWhiteSpace(start))
        {
            return null;
        }

        var directory = new DirectoryInfo(Path.GetFullPath(start));
        for (var depth = 0; directory is not null && depth < 12; depth++)
        {
            if (File.Exists(Path.Combine(directory.FullName, "run.py")))
            {
                return directory.FullName;
            }

            directory = directory.Parent;
        }

        return null;
    }
}
