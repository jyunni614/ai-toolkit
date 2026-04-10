using Microsoft.Data.Sqlite;

namespace AiToolkit.Web;

public sealed class ToolkitRepository
{
    private readonly ToolkitPaths _paths;
    private readonly SemaphoreSlim _settingsSemaphore = new(1, 1);
    private SettingsDto? _settingsCache;

    public ToolkitRepository(ToolkitPaths paths)
    {
        _paths = paths;
    }

    public async Task EnsureDatabaseAsync()
    {
        Directory.CreateDirectory(Path.GetDirectoryName(_paths.DatabasePath)!);

        await using var connection = await OpenConnectionAsync();
        var commands = new[]
        {
            """
            CREATE TABLE IF NOT EXISTS Settings (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                key TEXT NOT NULL UNIQUE,
                value TEXT NOT NULL DEFAULT ''
            );
            """,
            """
            CREATE TABLE IF NOT EXISTS Queue (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                gpu_ids TEXT NOT NULL UNIQUE,
                is_running INTEGER NOT NULL DEFAULT 0
            );
            """,
            """
            CREATE TABLE IF NOT EXISTS Job (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL UNIQUE,
                gpu_ids TEXT NOT NULL,
                job_config TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                status TEXT NOT NULL DEFAULT 'stopped',
                stop INTEGER NOT NULL DEFAULT 0,
                return_to_queue INTEGER NOT NULL DEFAULT 0,
                step INTEGER NOT NULL DEFAULT 0,
                info TEXT NOT NULL DEFAULT '',
                speed_string TEXT NOT NULL DEFAULT '',
                queue_position INTEGER NOT NULL DEFAULT 0,
                pid INTEGER NULL
            );
            """
        };

        foreach (var sql in commands)
        {
            await using var command = connection.CreateCommand();
            command.CommandText = sql;
            await command.ExecuteNonQueryAsync();
        }

        await EnsureColumnAsync(connection, "Queue", "is_running", "INTEGER NOT NULL DEFAULT 0");

        await EnsureColumnAsync(connection, "Job", "status", "TEXT NOT NULL DEFAULT 'stopped'");
        await EnsureColumnAsync(connection, "Job", "stop", "INTEGER NOT NULL DEFAULT 0");
        await EnsureColumnAsync(connection, "Job", "return_to_queue", "INTEGER NOT NULL DEFAULT 0");
        await EnsureColumnAsync(connection, "Job", "step", "INTEGER NOT NULL DEFAULT 0");
        await EnsureColumnAsync(connection, "Job", "info", "TEXT NOT NULL DEFAULT ''");
        await EnsureColumnAsync(connection, "Job", "speed_string", "TEXT NOT NULL DEFAULT ''");
        await EnsureColumnAsync(connection, "Job", "queue_position", "INTEGER NOT NULL DEFAULT 0");
        await EnsureColumnAsync(connection, "Job", "pid", "INTEGER NULL");

        if (await ColumnExistsAsync(connection, "Job", "updated_at"))
        {
            await using var normalizeUpdatedAt = connection.CreateCommand();
            normalizeUpdatedAt.CommandText =
                "UPDATE Job SET updated_at = COALESCE(NULLIF(updated_at, ''), created_at, CURRENT_TIMESTAMP) WHERE updated_at IS NULL OR updated_at = '';";
            await normalizeUpdatedAt.ExecuteNonQueryAsync();
        }

        var indexCommands = new[]
        {
            "CREATE INDEX IF NOT EXISTS idx_job_status ON Job(status);",
            "CREATE INDEX IF NOT EXISTS idx_job_gpu_ids ON Job(gpu_ids);",
            "CREATE INDEX IF NOT EXISTS idx_queue_gpu_ids ON Queue(gpu_ids);"
        };

        foreach (var sql in indexCommands)
        {
            await using var command = connection.CreateCommand();
            command.CommandText = sql;
            await command.ExecuteNonQueryAsync();
        }

        if (await ColumnExistsAsync(connection, "Job", "updated_at"))
        {
            await using var dropTrigger = connection.CreateCommand();
            dropTrigger.CommandText = "DROP TRIGGER IF EXISTS trg_job_updated_at;";
            await dropTrigger.ExecuteNonQueryAsync();

            await using var createTrigger = connection.CreateCommand();
            createTrigger.CommandText =
                """
                CREATE TRIGGER trg_job_updated_at
                AFTER UPDATE ON Job
                FOR EACH ROW
                BEGIN
                    UPDATE Job SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
                END;
                """;
            await createTrigger.ExecuteNonQueryAsync();
        }
    }

    public async Task<SettingsDto> GetSettingsAsync()
    {
        if (_settingsCache is not null)
        {
            return _settingsCache;
        }

        await _settingsSemaphore.WaitAsync();
        try
        {
            if (_settingsCache is not null)
            {
                return _settingsCache;
            }

            await using var connection = await OpenConnectionAsync();
            await using var command = connection.CreateCommand();
            command.CommandText = "SELECT key, value FROM Settings;";
            await using var reader = await command.ExecuteReaderAsync();

            var map = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            while (await reader.ReadAsync())
            {
                map[reader.GetString(0)] = reader.GetString(1);
            }

            _settingsCache = new SettingsDto(
                map.GetValueOrDefault("HF_TOKEN", string.Empty),
                DefaultIfEmpty(map.GetValueOrDefault("TRAINING_FOLDER"), _paths.DefaultTrainingFolder),
                DefaultIfEmpty(map.GetValueOrDefault("DATASETS_FOLDER"), _paths.DefaultDatasetsFolder),
                DefaultIfEmpty(map.GetValueOrDefault("DATA_ROOT"), _paths.DefaultDataRoot));
            return _settingsCache;
        }
        finally
        {
            _settingsSemaphore.Release();
        }
    }

    public async Task SaveSettingsAsync(SettingsUpdateRequest request)
    {
        await using var connection = await OpenConnectionAsync();
        var pairs = new Dictionary<string, string>
        {
            ["HF_TOKEN"] = request.HfToken ?? string.Empty,
            ["TRAINING_FOLDER"] = request.TrainingFolder ?? string.Empty,
            ["DATASETS_FOLDER"] = request.DatasetsFolder ?? string.Empty,
            ["DATA_ROOT"] = request.DataRoot ?? string.Empty
        };

        foreach (var pair in pairs)
        {
            await using var command = connection.CreateCommand();
            command.CommandText =
                "INSERT INTO Settings(key, value) VALUES($key, $value) " +
                "ON CONFLICT(key) DO UPDATE SET value = excluded.value;";
            command.Parameters.AddWithValue("$key", pair.Key);
            command.Parameters.AddWithValue("$value", pair.Value);
            await command.ExecuteNonQueryAsync();
        }

        _settingsCache = null;
    }

    public async Task<JobDto[]> GetJobsAsync()
    {
        await using var connection = await OpenConnectionAsync();
        await using var command = connection.CreateCommand();
        command.CommandText =
            "SELECT id, name, gpu_ids, job_config, created_at, updated_at, status, stop, return_to_queue, step, info, speed_string, queue_position, pid " +
            "FROM Job ORDER BY datetime(created_at) DESC;";
        await using var reader = await command.ExecuteReaderAsync();

        var jobs = new List<JobDto>();
        while (await reader.ReadAsync())
        {
            jobs.Add(ReadJob(reader));
        }

        return jobs.ToArray();
    }

    public async Task<JobDto?> GetJobAsync(string id)
    {
        await using var connection = await OpenConnectionAsync();
        await using var command = connection.CreateCommand();
        command.CommandText =
            "SELECT id, name, gpu_ids, job_config, created_at, updated_at, status, stop, return_to_queue, step, info, speed_string, queue_position, pid " +
            "FROM Job WHERE id = $id LIMIT 1;";
        command.Parameters.AddWithValue("$id", id);
        await using var reader = await command.ExecuteReaderAsync();
        return await reader.ReadAsync() ? ReadJob(reader) : null;
    }

    public async Task<JobDto[]> GetJobsForGpuAsync(string gpuIds, params string[] statuses)
    {
        await using var connection = await OpenConnectionAsync();
        await using var command = connection.CreateCommand();
        var placeholders = new List<string>();
        for (var i = 0; i < statuses.Length; i++)
        {
            var parameterName = "$status" + i;
            placeholders.Add(parameterName);
            command.Parameters.AddWithValue(parameterName, statuses[i]);
        }

        command.Parameters.AddWithValue("$gpu", gpuIds);
        command.CommandText =
            "SELECT id, name, gpu_ids, job_config, created_at, updated_at, status, stop, return_to_queue, step, info, speed_string, queue_position, pid " +
            $"FROM Job WHERE gpu_ids = $gpu AND status IN ({string.Join(", ", placeholders)}) ORDER BY queue_position ASC;";
        await using var reader = await command.ExecuteReaderAsync();

        var jobs = new List<JobDto>();
        while (await reader.ReadAsync())
        {
            jobs.Add(ReadJob(reader));
        }

        return jobs.ToArray();
    }

    public async Task<JobDto> SaveJobAsync(string? id, string name, string gpuIds, string jobConfig)
    {
        if (!string.IsNullOrWhiteSpace(id))
        {
            await UpdateJobAsync(id, new ToolkitJobUpdate
            {
                Name = name,
                GpuIds = gpuIds,
                JobConfig = jobConfig
            });
            return (await GetJobAsync(id))!;
        }

        var newId = Guid.NewGuid().ToString("D");
        var queuePosition = await GetNextQueuePositionAsync();

        await using var connection = await OpenConnectionAsync();
        await using var command = connection.CreateCommand();
        command.CommandText =
            "INSERT INTO Job(id, name, gpu_ids, job_config, status, stop, return_to_queue, step, info, speed_string, queue_position) " +
            "VALUES($id, $name, $gpu_ids, $job_config, 'stopped', 0, 0, 0, '', '', $queue_position);";
        command.Parameters.AddWithValue("$id", newId);
        command.Parameters.AddWithValue("$name", name);
        command.Parameters.AddWithValue("$gpu_ids", gpuIds);
        command.Parameters.AddWithValue("$job_config", jobConfig);
        command.Parameters.AddWithValue("$queue_position", queuePosition);
        await command.ExecuteNonQueryAsync();

        return (await GetJobAsync(newId))!;
    }

    public async Task DeleteJobAsync(string id)
    {
        await using var connection = await OpenConnectionAsync();
        await using var command = connection.CreateCommand();
        command.CommandText = "DELETE FROM Job WHERE id = $id;";
        command.Parameters.AddWithValue("$id", id);
        await command.ExecuteNonQueryAsync();
    }

    public async Task<int> GetNextQueuePositionAsync()
    {
        await using var connection = await OpenConnectionAsync();
        await using var command = connection.CreateCommand();
        command.CommandText = "SELECT COALESCE(MAX(queue_position), 0) FROM Job;";
        var result = await command.ExecuteScalarAsync();
        return Convert.ToInt32(result) + 1000;
    }

    public async Task UpdateJobAsync(string id, ToolkitJobUpdate update)
    {
        var sets = new List<string>();
        await using var connection = await OpenConnectionAsync();
        await using var command = connection.CreateCommand();

        void Add(string sql, string parameterName, object? value)
        {
            sets.Add(sql);
            command.Parameters.AddWithValue(parameterName, value ?? DBNull.Value);
        }

        if (update.Name is not null)
        {
            Add("name = $name", "$name", update.Name);
        }

        if (update.GpuIds is not null)
        {
            Add("gpu_ids = $gpu_ids", "$gpu_ids", update.GpuIds);
        }

        if (update.JobConfig is not null)
        {
            Add("job_config = $job_config", "$job_config", update.JobConfig);
        }

        if (update.Status is not null)
        {
            Add("status = $status", "$status", update.Status);
        }

        if (update.Stop.HasValue)
        {
            Add("stop = $stop", "$stop", update.Stop.Value ? 1 : 0);
        }

        if (update.ReturnToQueue.HasValue)
        {
            Add("return_to_queue = $return_to_queue", "$return_to_queue", update.ReturnToQueue.Value ? 1 : 0);
        }

        if (update.Step.HasValue)
        {
            Add("step = $step", "$step", update.Step.Value);
        }

        if (update.Info is not null)
        {
            Add("info = $info", "$info", update.Info);
        }

        if (update.SpeedString is not null)
        {
            Add("speed_string = $speed_string", "$speed_string", update.SpeedString);
        }

        if (update.QueuePosition.HasValue)
        {
            Add("queue_position = $queue_position", "$queue_position", update.QueuePosition.Value);
        }

        if (update.Pid.HasValue)
        {
            Add("pid = $pid", "$pid", update.Pid.Value);
        }

        if (update.SetPidToNull)
        {
            sets.Add("pid = NULL");
        }

        if (sets.Count == 0)
        {
            return;
        }

        if (await ColumnExistsAsync(connection, "Job", "updated_at"))
        {
            sets.Add("updated_at = CURRENT_TIMESTAMP");
        }

        command.Parameters.AddWithValue("$id", id);
        command.CommandText = $"UPDATE Job SET {string.Join(", ", sets)} WHERE id = $id;";
        await command.ExecuteNonQueryAsync();
    }

    public async Task<QueueDto[]> GetQueuesAsync()
    {
        await using var connection = await OpenConnectionAsync();
        await using var command = connection.CreateCommand();
        command.CommandText = "SELECT id, gpu_ids, is_running FROM Queue ORDER BY gpu_ids ASC;";
        await using var reader = await command.ExecuteReaderAsync();

        var queues = new List<QueueDto>();
        while (await reader.ReadAsync())
        {
            queues.Add(ReadQueue(reader));
        }

        return queues.ToArray();
    }

    public async Task<QueueDto?> GetQueueAsync(string gpuIds)
    {
        await using var connection = await OpenConnectionAsync();
        await using var command = connection.CreateCommand();
        command.CommandText = "SELECT id, gpu_ids, is_running FROM Queue WHERE gpu_ids = $gpu_ids LIMIT 1;";
        command.Parameters.AddWithValue("$gpu_ids", gpuIds);
        await using var reader = await command.ExecuteReaderAsync();
        return await reader.ReadAsync() ? ReadQueue(reader) : null;
    }

    public async Task EnsureQueueAsync(string gpuIds, bool isRunning)
    {
        await using var connection = await OpenConnectionAsync();
        await using var command = connection.CreateCommand();
        command.CommandText =
            "INSERT INTO Queue(gpu_ids, is_running) VALUES($gpu_ids, $is_running) " +
            "ON CONFLICT(gpu_ids) DO NOTHING;";
        command.Parameters.AddWithValue("$gpu_ids", gpuIds);
        command.Parameters.AddWithValue("$is_running", isRunning ? 1 : 0);
        await command.ExecuteNonQueryAsync();
    }

    public async Task SetQueueRunningAsync(string gpuIds, bool isRunning)
    {
        await EnsureQueueAsync(gpuIds, isRunning);
        await using var connection = await OpenConnectionAsync();
        await using var command = connection.CreateCommand();
        command.CommandText = "UPDATE Queue SET is_running = $is_running WHERE gpu_ids = $gpu_ids;";
        command.Parameters.AddWithValue("$gpu_ids", gpuIds);
        command.Parameters.AddWithValue("$is_running", isRunning ? 1 : 0);
        await command.ExecuteNonQueryAsync();
    }

    private async Task<SqliteConnection> OpenConnectionAsync()
    {
        Directory.CreateDirectory(Path.GetDirectoryName(_paths.DatabasePath)!);
        var connection = new SqliteConnection(new SqliteConnectionStringBuilder
        {
            DataSource = _paths.DatabasePath,
            Mode = SqliteOpenMode.ReadWriteCreate,
            Cache = SqliteCacheMode.Shared
        }.ToString());
        await connection.OpenAsync();
        return connection;
    }

    private static async Task EnsureColumnAsync(SqliteConnection connection, string tableName, string columnName, string definition)
    {
        if (await ColumnExistsAsync(connection, tableName, columnName))
        {
            return;
        }

        await using var command = connection.CreateCommand();
        command.CommandText = $"ALTER TABLE {tableName} ADD COLUMN {columnName} {definition};";
        await command.ExecuteNonQueryAsync();
    }

    private static async Task<bool> ColumnExistsAsync(SqliteConnection connection, string tableName, string columnName)
    {
        await using var command = connection.CreateCommand();
        command.CommandText = $"PRAGMA table_info({tableName});";
        await using var reader = await command.ExecuteReaderAsync();
        while (await reader.ReadAsync())
        {
            if (string.Equals(reader.GetString(1), columnName, StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }
        }

        return false;
    }

    private static JobDto ReadJob(SqliteDataReader reader)
    {
        return new JobDto(
            reader.GetString(0),
            reader.GetString(1),
            reader.GetString(2),
            reader.GetString(3),
            reader.GetString(4),
            reader.GetString(5),
            reader.GetString(6),
            reader.GetInt64(7) != 0,
            reader.GetInt64(8) != 0,
            reader.GetInt32(9),
            reader.GetString(10),
            reader.GetString(11),
            reader.GetInt32(12),
            reader.IsDBNull(13) ? null : reader.GetInt32(13));
    }

    private static QueueDto ReadQueue(SqliteDataReader reader)
    {
        return new QueueDto(reader.GetInt32(0), reader.GetString(1), reader.GetInt64(2) != 0);
    }

    private static string DefaultIfEmpty(string? value, string fallback)
    {
        return string.IsNullOrWhiteSpace(value) ? fallback : value;
    }
}
