namespace AiToolkit.Web;

public sealed class QueueWorker : BackgroundService
{
    private readonly ToolkitRepository _repository;
    private readonly JobManager _jobManager;
    private readonly ILogger<QueueWorker> _logger;

    public QueueWorker(ToolkitRepository repository, JobManager jobManager, ILogger<QueueWorker> logger)
    {
        _repository = repository;
        _jobManager = jobManager;
        _logger = logger;
    }

    public override async Task StartAsync(CancellationToken cancellationToken)
    {
        await _jobManager.RecoverRunningJobsAsync();
        await base.StartAsync(cancellationToken);
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(1));
        while (!stoppingToken.IsCancellationRequested && await timer.WaitForNextTickAsync(stoppingToken))
        {
            try
            {
                await TickAsync(stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Queue worker tick failed");
            }
        }
    }

    private async Task TickAsync(CancellationToken cancellationToken)
    {
        var jobs = await _repository.GetJobsAsync();
        foreach (var job in jobs.Where(job => job.Status is "running" or "stopping"))
        {
            await _jobManager.RefreshRuntimeAsync(job);
        }

        jobs = await _repository.GetJobsAsync();
        var queues = await _repository.GetQueuesAsync();
        foreach (var queue in queues.OrderBy(queue => queue.Id))
        {
            if (!queue.IsRunning)
            {
                var activeJobs = jobs.Where(job => job.GpuIds == queue.GpuIds && (job.Status is "running" or "stopping")).ToArray();
                foreach (var activeJob in activeJobs)
                {
                    if (!activeJob.ReturnToQueue || !activeJob.Stop)
                    {
                        await _jobManager.RequestStopAsync(activeJob, requeue: true);
                    }
                }

                continue;
            }

            var hasActiveJob = jobs.Any(job => job.GpuIds == queue.GpuIds && (job.Status is "running" or "stopping"));
            if (hasActiveJob)
            {
                continue;
            }

            var nextJob = jobs
                .Where(job => job.GpuIds == queue.GpuIds && job.Status == "queued")
                .OrderBy(job => job.QueuePosition)
                .FirstOrDefault();
            if (nextJob is null)
            {
                await _repository.SetQueueRunningAsync(queue.GpuIds, false);
                continue;
            }

            await _jobManager.StartJobAsync(nextJob, cancellationToken);
        }
    }
}

