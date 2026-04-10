const app = document.getElementById('app');
const toastLayer = document.getElementById('toast-layer');

const state = {
  meta: null,
  authorized: false,
  loading: true,
  route: null,
  overview: { jobs: [], queues: [], gpu: null, cpu: null },
  settings: null,
  editor: null,
  jobDetail: null,
  datasets: { list: [], currentName: null, images: [], selectedImage: null, caption: '', stashUploads: [] },
  viewState: { jobLog: null },
};

let pollHandle = null;
let routeNonce = 0;

boot().catch((error) => {
  console.error(error);
  showToast(error.message || 'Failed to boot the UI', 'error');
  render();
});

async function boot() {
  bindEvents();
  state.meta = await fetchJson('/api/meta', { allowAnonymous: true });
  await verifyAuth();

  if (!window.location.hash) {
    window.location.hash = '#/dashboard';
  }

  window.addEventListener('hashchange', () => {
    void refreshRoute();
  });

  await refreshRoute();
}

function bindEvents() {
  app.addEventListener('click', (event) => {
    const target = event.target.closest('[data-action]');
    if (!target) {
      return;
    }

    const action = target.dataset.action;
    if (!action) {
      return;
    }

    event.preventDefault();
    void handleAction(action, target);
  });

  app.addEventListener('submit', (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) {
      return;
    }

    event.preventDefault();
    void handleSubmit(form, event.submitter);
  });

  app.addEventListener('change', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }

    if (target.matches('[data-change="loss-key"]')) {
      state.jobDetail = state.jobDetail || {};
      state.jobDetail.lossKey = target.value;
      void reloadCurrentJobDetail();
      return;
    }

    if (target.matches('[data-change="dataset-picker"]') && target instanceof HTMLSelectElement) {
      if (target.value) {
        window.location.hash = `#/datasets/${encodeURIComponent(target.value)}`;
      }
      return;
    }

    if (target.matches('[data-change="simple-dataset-preset"]') && target instanceof HTMLSelectElement) {
      const form = target.form;
      const input = form?.elements.namedItem('datasetPath');
      if (input instanceof HTMLInputElement && target.value) {
        input.value = target.value;
      }
      return;
    }

    if (target.matches('[data-change="simple-model-arch"]') && target instanceof HTMLSelectElement) {
      if (!syncSimpleEditorFromDom()) {
        return;
      }
      applySimpleModelArch(target.value);
      render();
      return;
    }

    if (target.matches('[data-change="simple-job-type"]') && target instanceof HTMLSelectElement) {
      if (!syncSimpleEditorFromDom()) {
        return;
      }
      applySimpleJobType(target.value);
      render();
    }
  });
}

async function verifyAuth() {
  if (!state.meta?.authRequired) {
    state.authorized = true;
    return;
  }

  const token = localStorage.getItem('AI_TOOLKIT_AUTH');
  if (!token) {
    state.authorized = false;
    return;
  }

  try {
    const response = await fetchJson('/api/auth');
    state.authorized = Boolean(response?.isAuthenticated);
  } catch {
    localStorage.removeItem('AI_TOOLKIT_AUTH');
    state.authorized = false;
  }
}

async function refreshRoute() {
  clearPoller();
  const nonce = ++routeNonce;
  state.route = parseRoute();
  state.loading = true;
  render();

  if (state.meta?.authRequired && !state.authorized) {
    state.loading = false;
    render();
    return;
  }

  try {
    switch (state.route.section) {
      case 'dashboard':
        await loadOverview();
        setPoller(async () => {
          await loadOverview();
          render();
        }, 5000);
        break;
      case 'jobs':
        if (state.route.mode === 'list') {
          await loadOverview();
          setPoller(async () => {
            await loadOverview();
            render();
          }, 5000);
        } else if (state.route.mode === 'editor') {
          await loadSettings();
          await loadJobEditor();
        } else {
          await loadOverview();
          await loadJobDetail();
          setPoller(async () => {
            await loadOverview();
            await loadJobDetail();
            render();
          }, 5000);
        }
        break;
      case 'datasets':
        await loadDatasets();
        break;
      case 'settings':
        await loadSettings();
        break;
      default:
        window.location.hash = '#/dashboard';
        return;
    }
  } catch (error) {
    console.error(error);
    showToast(error.message || 'Route load failed', 'error');
  } finally {
    if (nonce === routeNonce) {
      state.loading = false;
      render();
    }
  }
}

async function loadOverview() {
  const [jobsPayload, queuesPayload, gpu, cpu] = await Promise.all([
    fetchJson('/api/jobs'),
    fetchJson('/api/queue'),
    fetchJson('/api/gpu'),
    fetchJson('/api/cpu'),
  ]);

  state.overview = {
    jobs: normalizeJobs(jobsPayload),
    queues: normalizeQueues(queuesPayload),
    gpu,
    cpu,
  };
}

async function loadSettings() {
  state.settings = await fetchJson('/api/settings');
}

async function loadJobEditor() {
  const route = state.route;
  const [gpuInfo, datasetsPayload] = await Promise.all([
    fetchJson('/api/gpu'),
    fetchJson('/api/datasets/list'),
  ]);

  const templateObject = createJobTemplateObject();
  const base = {
    id: null,
    mode: route.modeSource || 'new',
    viewMode: route.modeSource === 'edit' ? 'advanced' : 'simple',
    name: templateObject.config.name,
    gpuIds: defaultGpuIds(gpuInfo),
    jobConfig: stringifyJson(templateObject),
    gpuInfo,
    datasetNames: normalizeDatasets(datasetsPayload),
  };

  const datasetOptions = buildDatasetOptions(base.datasetNames, state.settings);
  if (datasetOptions.length) {
    const templateConfig = normalizeJobConfig(tryParseJson(base.jobConfig));
    if (templateConfig.config.process[0].datasets[0].folder_path === DEFAULT_DATASET_CONFIG.folder_path) {
      templateConfig.config.process[0].datasets[0].folder_path = datasetOptions[0].value;
      base.jobConfig = stringifyJson(templateConfig);
    }
  }

  if (route.jobId) {
    const job = await fetchJson(`/api/jobs?id=${encodeURIComponent(route.jobId)}`);
    const configObject = normalizeJobConfig(tryParseJson(job.jobConfig));
    base.name = route.modeSource === 'clone' ? `${job.name}_clone` : job.name;
    base.gpuIds = job.gpuIds || defaultGpuIds(gpuInfo);
    if (route.modeSource === 'clone') {
      configObject.config.name = base.name;
    }
    base.jobConfig = stringifyJson(configObject);
    base.id = route.modeSource === 'edit' ? job.id : null;
  }

  state.editor = base;
}

async function loadJobDetail() {
  const jobId = state.route.jobId;
  const lossKey = state.jobDetail?.lossKey || 'loss';
  const [job, logPayload, samplesPayload, filesPayload, lossPayload, queuesPayload] = await Promise.all([
    fetchJson(`/api/jobs?id=${encodeURIComponent(jobId)}`),
    fetchJson(`/api/jobs/${encodeURIComponent(jobId)}/log`),
    fetchJson(`/api/jobs/${encodeURIComponent(jobId)}/samples`),
    fetchJson(`/api/jobs/${encodeURIComponent(jobId)}/files`),
    fetchJson(`/api/jobs/${encodeURIComponent(jobId)}/loss?key=${encodeURIComponent(lossKey)}&limit=300&stride=1`),
    fetchJson('/api/queue'),
  ]);

  const selectedLossKey = lossPayload.keys?.includes(lossKey)
    ? lossKey
    : lossPayload.keys?.[0] || lossPayload.key || 'loss';

  state.jobDetail = {
    job,
    log: logPayload.log || '',
    samples: samplesPayload.samples || [],
    files: filesPayload.files || [],
    loss: lossPayload,
    lossKey: selectedLossKey,
    queues: normalizeQueues(queuesPayload),
  };

  if (selectedLossKey !== lossKey) {
    state.jobDetail.loss = await fetchJson(`/api/jobs/${encodeURIComponent(jobId)}/loss?key=${encodeURIComponent(selectedLossKey)}&limit=300&stride=1`);
  }
}

async function reloadCurrentJobDetail() {
  if (state.route?.section === 'jobs' && state.route.mode === 'detail') {
    state.loading = true;
    render();
    try {
      await loadOverview();
      await loadJobDetail();
    } catch (error) {
      showToast(error.message || 'Failed to refresh job', 'error');
    } finally {
      state.loading = false;
      render();
    }
  }
}

async function loadDatasets() {
  const listPayload = await fetchJson('/api/datasets/list');
  const list = normalizeDatasets(listPayload);
  let currentName = state.route.datasetName || state.datasets.currentName || list[0] || null;
  if (currentName && !list.includes(currentName)) {
    currentName = list[0] || null;
  }

  let images = [];
  let selectedImage = null;
  let caption = '';

  if (currentName) {
    const imagesPayload = await fetchJson('/api/datasets/listImages', {
      method: 'POST',
      json: { datasetName: currentName },
    });

    images = imagesPayload.images || [];
    selectedImage = state.datasets.selectedImage && images.some((item) => item.imgPath === state.datasets.selectedImage)
      ? state.datasets.selectedImage
      : images[0]?.imgPath || null;

    if (selectedImage) {
      caption = await fetchText('/api/caption/get', {
        method: 'POST',
        json: { imgPath: selectedImage },
      });
    }
  }

  state.datasets = {
    list,
    currentName,
    images,
    selectedImage,
    caption,
    stashUploads: state.datasets?.stashUploads || [],
  };
}

function parseRoute() {
  const hash = (window.location.hash || '#/dashboard').replace(/^#/, '');
  const path = hash.startsWith('/') ? hash : `/${hash}`;
  const parts = path.split('/').filter(Boolean).map((part) => decodeURIComponent(part));

  if (parts[0] === 'jobs') {
    if (!parts[1]) {
      return { section: 'jobs', mode: 'list' };
    }

    if (parts[1] === 'new') {
      return { section: 'jobs', mode: 'editor', modeSource: 'new', jobId: null };
    }

    if (parts[2] === 'edit') {
      return { section: 'jobs', mode: 'editor', modeSource: 'edit', jobId: parts[1] };
    }

    if (parts[2] === 'clone') {
      return { section: 'jobs', mode: 'editor', modeSource: 'clone', jobId: parts[1] };
    }

    return { section: 'jobs', mode: 'detail', jobId: parts[1] };
  }

  if (parts[0] === 'datasets') {
    return { section: 'datasets', datasetName: parts[1] || null };
  }

  if (parts[0] === 'settings') {
    return { section: 'settings' };
  }

  return { section: 'dashboard' };
}

function setPoller(fn, intervalMs) {
  clearPoller();
  pollHandle = window.setInterval(() => {
    void fn();
  }, intervalMs);
}

function clearPoller() {
  if (pollHandle) {
    window.clearInterval(pollHandle);
    pollHandle = null;
  }
}

function render() {
  captureTransientViewState();

  if (state.meta?.authRequired && !state.authorized) {
    app.innerHTML = renderLogin();
    return;
  }

  const view = renderCurrentView();
  app.innerHTML = renderShell(view);
  restoreTransientViewState();
}

function captureTransientViewState() {
  if (state.route?.section === 'jobs' && state.route.mode === 'detail') {
    const logBlock = document.getElementById('job-live-log');
    if (logBlock instanceof HTMLElement) {
      const maxScrollTop = Math.max(0, logBlock.scrollHeight - logBlock.clientHeight);
      state.viewState.jobLog = {
        scrollTop: logBlock.scrollTop,
        stickToBottom: maxScrollTop - logBlock.scrollTop <= 24,
      };
    }
    return;
  }

  state.viewState.jobLog = null;
}

function restoreTransientViewState() {
  if (!(state.route?.section === 'jobs' && state.route.mode === 'detail')) {
    return;
  }

  const logBlock = document.getElementById('job-live-log');
  const saved = state.viewState.jobLog;
  if (!(logBlock instanceof HTMLElement) || !saved) {
    return;
  }

  if (saved.stickToBottom) {
    logBlock.scrollTop = logBlock.scrollHeight - logBlock.clientHeight;
    return;
  }

  logBlock.scrollTop = Math.min(saved.scrollTop, Math.max(0, logBlock.scrollHeight - logBlock.clientHeight));
}

function renderCurrentView() {
  if (state.loading) {
    return {
      title: titleForRoute(),
      subtitle: subtitleForRoute(),
      actions: topbarActions(),
      content: renderLoadingState(),
    };
  }

  switch (state.route?.section) {
    case 'dashboard':
      return renderDashboardView();
    case 'jobs':
      if (state.route.mode === 'list') {
        return renderJobsListView();
      }
      if (state.route.mode === 'editor') {
        return renderJobEditorView();
      }
      return renderJobDetailView();
    case 'datasets':
      return renderDatasetsView();
    case 'settings':
      return renderSettingsView();
    default:
      return {
        title: 'AI Toolkit Web',
        subtitle: 'Static frontend shell',
        actions: topbarActions(),
        content: renderEmptyState('Unknown route.'),
      };
  }
}
function renderShell(view) {
  return `
    <div class="app-shell">
      <aside class="sidebar">
        <div class="brand-card">
          <div class="brand-kicker">Native AOT replacement</div>
          <h1>AI Toolkit Web</h1>
          <p>Minimal API backend, static frontend shell, and a worker loop that replaces the Next.js + cron split.</p>
        </div>
        <nav class="nav-links">
          ${renderNavLink('dashboard', '#/dashboard', 'Dashboard', 'GPU, CPU, queues')}
          ${renderNavLink('jobs', '#/jobs', 'Jobs', 'Queue, edit, detail')}
          ${renderNavLink('datasets', '#/datasets', 'Datasets', 'Browse and caption')}
          ${renderNavLink('settings', '#/settings', 'Settings', 'Paths and tokens')}
        </nav>
        <div class="sidebar-foot">
          <div class="meta-card">
            <div class="meta-label">Platform</div>
            <div class="meta-value">${escapeHtml(state.meta?.platform || 'unknown')}</div>
          </div>
          <div class="meta-card">
            <div class="meta-label">Toolkit Root</div>
            <div class="meta-value mono">${escapeHtml(state.meta?.toolkitRoot || '')}</div>
          </div>
        </div>
      </aside>
      <div class="content-shell">
        <header class="topbar">
          <div class="page-title">
            <h2>${escapeHtml(view.title)}</h2>
            <p>${escapeHtml(view.subtitle)}</p>
          </div>
          <div class="topbar-actions">
            ${view.actions}
          </div>
        </header>
        <main class="content-scroll">${view.content}</main>
      </div>
    </div>
  `;
}

function renderNavLink(section, href, title, meta) {
  const isActive = state.route?.section === section;
  return `
    <a class="nav-link ${isActive ? 'active' : ''}" href="${href}">
      <div class="nav-label">
        <span class="nav-title">${title}</span>
        <span class="nav-meta">${meta}</span>
      </div>
      <span class="badge ${isActive ? 'info' : ''}">${isActive ? 'Open' : 'Go'}</span>
    </a>
  `;
}

function topbarActions(extra = '') {
  const authButton = state.meta?.authRequired
    ? '<button class="ghost-button" data-action="logout">Log out</button>'
    : '';

  return `${extra}<button class="ghost-button" data-action="refresh-route">Refresh</button>${authButton}`;
}

function renderDashboardView() {
  const jobs = state.overview.jobs;
  const queues = state.overview.queues;
  const gpuList = state.overview.gpu?.gpus || [];
  const cpu = state.overview.cpu;
  const counts = summarizeJobs(jobs);
  const activeJobs = jobs.filter((job) => ['queued', 'running', 'stopping'].includes(job.status));

  return {
    title: 'Dashboard',
    subtitle: 'Live system telemetry, queue toggles, and the jobs that are actively moving through training.',
    actions: topbarActions('<a class="button" href="#/jobs/new">New job</a>'),
    content: `
      <section class="metrics-grid">
        ${renderMetricCard('Running', counts.running, `${counts.queued} queued`)}
        ${renderMetricCard('Completed', counts.completed, `${counts.error} errored`)}
        ${renderMetricCard('Stopped', counts.stopped, `${counts.stopping} stopping`)}
        ${renderMetricCard('Queues', queues.filter((queue) => queue.isRunning).length, `${queues.length} discovered`)}
      </section>
      <section class="system-grid">
        <div class="panel">
          <div class="surface-header">
            <h3>GPU Queues</h3>
            <span class="badge info">${gpuList.length || (state.overview.gpu?.isMac ? 1 : 0)} devices</span>
          </div>
          <div class="stack">${renderGpuQueueCards(gpuList, queues)}</div>
        </div>
        <div class="panel">
          <div class="surface-header">
            <h3>CPU + Memory</h3>
            <span class="badge ${cpu?.currentLoad > 85 ? 'danger' : 'success'}">${formatNumber(cpu?.currentLoad)}% load</span>
          </div>
          ${renderCpuPanel(cpu)}
        </div>
      </section>
      <section class="hero-panel">
        <div class="hero-line">
          <h3>Active Jobs</h3>
          <div class="badge-row">
            <span class="badge info">Polling every 5s</span>
            <span class="badge">${activeJobs.length} visible</span>
          </div>
        </div>
        <div class="hero-copy">This view is intentionally lean: raw queue state, raw job status, and direct controls without client framework overhead.</div>
        <div class="table-shell" style="margin-top:18px;">
          <div class="table-scroll">
            ${renderJobsTable(activeJobs.length ? activeJobs : jobs.slice(0, 12))}
          </div>
        </div>
      </section>
    `,
  };
}

function renderJobsListView() {
  const jobs = state.overview.jobs;
  const queues = state.overview.queues;
  const counts = summarizeJobs(jobs);
  return {
    title: 'Jobs',
    subtitle: 'Edit raw JSON configs, queue runs, inspect progress, and manage training artifacts without the old React surface.',
    actions: topbarActions('<a class="button" href="#/jobs/new">Create job</a>'),
    content: `
      <section class="metrics-grid">
        ${renderMetricCard('Total Jobs', jobs.length, `${counts.running} running now`)}
        ${renderMetricCard('Queued', counts.queued, `${counts.stopped} stopped`)}
        ${renderMetricCard('Finished', counts.completed, `${counts.error} error`)}
        ${renderMetricCard('Active Queues', queues.filter((queue) => queue.isRunning).length, 'Direct GPU toggles')}
      </section>
      <section class="hero-panel">
        <div class="hero-line">
          <h3>Job Registry</h3>
          <div class="inline-actions">
            ${renderQueueBadges(queues)}
          </div>
        </div>
        <div class="table-shell" style="margin-top:16px;">
          <div class="table-scroll">
            ${renderJobsTable(jobs)}
          </div>
        </div>
      </section>
    `,
  };
}

function renderJobEditorView() {
  const editor = state.editor;
  const isEdit = editor?.mode === 'edit';
  const isAdvanced = editor?.viewMode === 'advanced';
  const title = isEdit ? `Edit ${editor.name}` : editor?.mode === 'clone' ? 'Clone job' : 'Create job';

  return {
    title,
    subtitle: isAdvanced
      ? 'Raw JSON stays available for the full schema, but it now gets the whole page width.'
      : 'The compact builder brings back the common job flow from the old UI and still lets you jump into raw JSON whenever you need it.',
    actions: topbarActions('<a class="ghost-button" href="#/jobs">Back to jobs</a>'),
    content: `
      <section class="stack">
        <div class="panel">
          <div class="surface-header">
            <div>
              <h3>${isAdvanced ? 'Advanced JSON editor' : 'Simple job builder'}</h3>
              <div class="panel-copy">${isAdvanced
                ? 'Full-schema editing is still here, but the editor is no longer squeezed into a narrow column.'
                : 'Use the common training knobs first, then switch to raw JSON only for the unusual cases.'}</div>
            </div>
            <div class="badge-row">
              <span class="badge ${isAdvanced ? 'warning' : 'success'}">${isAdvanced ? 'Advanced' : 'Simple'}</span>
              <span class="badge info">AOT-safe frontend</span>
            </div>
          </div>
          ${renderJobEditorModeToggle(editor)}
        </div>
        ${renderJobEditorInfoPanel(editor, state.settings)}
        ${isAdvanced ? renderAdvancedJobEditor(editor) : renderSimpleJobEditor(editor, state.settings)}
      </section>
    `,
  };
}

function renderJobEditorModeToggle(editor) {
  const current = editor?.viewMode === 'advanced' ? 'advanced' : 'simple';
  return `
    <div class="mode-switch" role="tablist" aria-label="Job editor mode">
      <button class="mode-button ${current === 'simple' ? 'active' : ''}" type="button" data-action="switch-job-editor-mode" data-mode="simple">Simple</button>
      <button class="mode-button ${current === 'advanced' ? 'active' : ''}" type="button" data-action="switch-job-editor-mode" data-mode="advanced">Advanced JSON</button>
    </div>
  `;
}

function renderJobEditorInfoPanel(editor, settings) {
  const datasetCount = editor?.datasetNames?.length || 0;
  const gpuCount = editor?.gpuInfo?.isMac ? 1 : editor?.gpuInfo?.gpus?.length || 0;
  const defaultGpu = editor?.gpuIds || defaultGpuIds(editor?.gpuInfo);

  return `
    <section class="job-info-grid">
      <div class="panel">
        <div class="surface-header">
          <h3>Runtime Paths</h3>
          <span class="badge info">Backend-owned</span>
        </div>
        <div class="kv-grid">
          <div class="kv-item">
            <div class="kv-label">Training Folder</div>
            <div class="kv-value mono">${escapeHtml(settings?.trainingFolder || '')}</div>
          </div>
          <div class="kv-item">
            <div class="kv-label">Datasets Folder</div>
            <div class="kv-value mono">${escapeHtml(settings?.datasetsFolder || '')}</div>
          </div>
          <div class="kv-item">
            <div class="kv-label">Data Root</div>
            <div class="kv-value mono">${escapeHtml(settings?.dataRoot || '')}</div>
          </div>
          <div class="kv-item">
            <div class="kv-label">Backend Notes</div>
            <div class="kv-value">Training folder, sqlite path, UI logging, and device flags are still injected server-side when the job runs.</div>
          </div>
        </div>
      </div>
      <div class="panel">
        <div class="surface-header">
          <h3>Editor Context</h3>
          <span class="badge success">Live metadata</span>
        </div>
        <div class="kv-grid">
          <div class="kv-item">
            <div class="kv-label">Loaded Datasets</div>
            <div class="kv-value">${datasetCount}</div>
          </div>
          <div class="kv-item">
            <div class="kv-label">Detected GPUs</div>
            <div class="kv-value">${gpuCount}</div>
          </div>
          <div class="kv-item">
            <div class="kv-label">Default Queue Target</div>
            <div class="kv-value mono">${escapeHtml(defaultGpu)}</div>
          </div>
          <div class="kv-item">
            <div class="kv-label">Mode Hint</div>
            <div class="kv-value">Simple mode preserves the common fields. Advanced mode keeps the entire JSON schema visible.</div>
          </div>
        </div>
      </div>
    </section>
  `;
}

function renderAdvancedJobEditor(editor) {
  const gpuChoices = renderGpuDataList(editor);

  return `
    <section class="hero-panel job-json-panel">
      <div class="hero-line">
        <h3>Job Definition JSON</h3>
        <div class="badge-row">
          <span class="badge info">Full schema</span>
          <span class="badge">${escapeHtml(`${(editor?.jobConfig || '').length.toLocaleString()} chars`)}</span>
        </div>
      </div>
      <form id="job-editor-form" class="stack">
        <input type="hidden" name="jobId" value="${escapeHtml(editor?.id || '')}">
        <div class="job-meta-grid">
          <div class="field">
            <label class="field-label" for="job-name">Job Name</label>
            <input id="job-name" name="name" value="${escapeHtml(editor?.name || '')}" required>
          </div>
          <div class="field">
            <label class="field-label" for="job-gpus">GPU Ids</label>
            <input id="job-gpus" name="gpuIds" list="gpu-id-options" value="${escapeHtml(editor?.gpuIds || defaultGpuIds(editor?.gpuInfo))}" placeholder="0 or 0,1 or mps">
            <div class="field-help">Use the same GPU id shape the backend queue uses.</div>
            ${gpuChoices}
          </div>
        </div>
        <div class="field">
          <label class="field-label" for="job-config">Job Config JSON</label>
          <textarea id="job-config" class="job-config-input" name="jobConfig" spellcheck="false">${escapeHtml(editor?.jobConfig || createJobTemplate())}</textarea>
          <div class="field-help">Pretty print if you need to reflow the document. The backend will still inject runtime-specific values at execution time.</div>
        </div>
        <div class="button-row">
          <button class="button" type="submit" name="submitAction" value="save">Save job</button>
          <button class="secondary-button" type="submit" name="submitAction" value="queue">Save and run queue</button>
          <button class="ghost-button" type="button" data-action="format-job-json">Pretty print JSON</button>
          <button class="ghost-button" type="button" data-action="load-job-template">Starter template</button>
        </div>
      </form>
    </section>
  `;
}

function renderSimpleJobEditor(editor, settings) {
  const jobConfig = getEditorConfig(editor);
  const process = jobConfig.config.process[0];
  const dataset = process.datasets[0];
  const slider = { ...DEFAULT_SLIDER_CONFIG, ...(process.slider || {}) };
  const modelOption = getSimpleModelOption(process.model.arch);
  const datasetOptions = buildDatasetOptions(editor?.datasetNames, settings);
  const selectedDataset = datasetOptions.some((item) => item.value === dataset.folder_path) ? dataset.folder_path : '';
  const samplePrompts = (process.sample.samples || []).map((item) => item.prompt || '').join('\n');
  const gpuChoices = renderGpuDataList(editor);

  return `
    <form id="job-editor-form" class="stack">
      <input type="hidden" name="jobId" value="${escapeHtml(editor?.id || '')}">
      <section class="simple-editor-grid">
        <div class="panel">
          <div class="surface-header">
            <h3>Job</h3>
            <span class="badge success">Common flow</span>
          </div>
          <div class="field">
            <label class="field-label" for="job-name">Training Name</label>
            <input id="job-name" name="name" value="${escapeHtml(jobConfig.config.name || editor?.name || '')}" required>
          </div>
          <div class="field">
            <label class="field-label" for="job-gpus">GPU Ids</label>
            <input id="job-gpus" name="gpuIds" list="gpu-id-options" value="${escapeHtml(editor?.gpuIds || defaultGpuIds(editor?.gpuInfo))}" placeholder="0 or mps">
            <div class="field-help">Single GPU is the happy path here. Use Advanced JSON for custom multi-GPU cases.</div>
            ${gpuChoices}
          </div>
          <div class="field">
            <label class="field-label" for="job-type">Job Type</label>
            <select id="job-type" name="jobType" data-change="simple-job-type">
              ${renderSelectOptions(SIMPLE_JOB_TYPE_OPTIONS, process.type)}
            </select>
          </div>
          <div class="field">
            <label class="field-label" for="trigger-word">Trigger Word</label>
            <input id="trigger-word" name="triggerWord" value="${escapeHtml(process.trigger_word || '')}" placeholder="Optional token">
          </div>
        </div>
        <div class="panel">
          <div class="surface-header">
            <h3>Model</h3>
            <span class="badge info">${escapeHtml(modelOption?.label || process.model.arch || 'Custom')}</span>
          </div>
          <div class="field">
            <label class="field-label" for="model-arch">Model Architecture</label>
            <select id="model-arch" name="modelArch" data-change="simple-model-arch">
              ${renderModelArchOptions(process.model.arch)}
            </select>
          </div>
          <div class="field">
            <label class="field-label" for="model-name-or-path">Name Or Path</label>
            <input id="model-name-or-path" name="modelNameOrPath" value="${escapeHtml(process.model.name_or_path || '')}" placeholder="ostris/Flex.1-alpha">
          </div>
          <div class="simple-grid-3">
            <div class="field">
              <label class="field-label" for="transformer-quant">Transformer Quant</label>
              <select id="transformer-quant" name="transformerQuant" ${modelOption?.disableQuantize ? 'disabled' : ''}>
                ${renderSelectOptions(QUANTIZATION_OPTIONS, process.model.quantize ? process.model.qtype : '')}
              </select>
            </div>
            <div class="field">
              <label class="field-label" for="text-encoder-quant">Text Encoder Quant</label>
              <select id="text-encoder-quant" name="textEncoderQuant" ${modelOption?.disableQuantize ? 'disabled' : ''}>
                ${renderSelectOptions(QUANTIZATION_OPTIONS, process.model.quantize_te ? process.model.qtype_te : '')}
              </select>
            </div>
            <div class="field">
              <label class="field-label">Options</label>
              <label class="toggle-row">
                <input type="checkbox" name="lowVram" ${process.model.low_vram ? 'checked' : ''}>
                <span>Low VRAM</span>
              </label>
            </div>
          </div>
        </div>
        <div class="panel">
          <div class="surface-header">
            <h3>Training</h3>
            <span class="badge warning">Core knobs</span>
          </div>
          <div class="simple-grid-3">
            <div class="field">
              <label class="field-label" for="steps">Steps</label>
              <input id="steps" name="steps" type="number" min="1" value="${escapeHtml(process.train.steps)}">
            </div>
            <div class="field">
              <label class="field-label" for="batch-size">Batch Size</label>
              <input id="batch-size" name="batchSize" type="number" min="1" value="${escapeHtml(process.train.batch_size)}">
            </div>
            <div class="field">
              <label class="field-label" for="grad-accum">Grad Accum</label>
              <input id="grad-accum" name="gradAccum" type="number" min="1" value="${escapeHtml(process.train.gradient_accumulation || 1)}">
            </div>
          </div>
          <div class="simple-grid-3">
            <div class="field">
              <label class="field-label" for="learning-rate">Learning Rate</label>
              <input id="learning-rate" name="learningRate" type="number" step="0.000001" min="0" value="${escapeHtml(process.train.lr)}">
            </div>
            <div class="field">
              <label class="field-label" for="save-every">Save Every</label>
              <input id="save-every" name="saveEvery" type="number" min="1" value="${escapeHtml(process.save.save_every)}">
            </div>
            <div class="field">
              <label class="field-label" for="max-saves">Keep Last</label>
              <input id="max-saves" name="maxSaves" type="number" min="1" value="${escapeHtml(process.save.max_step_saves_to_keep)}">
            </div>
          </div>
          <div class="field">
            <label class="field-label" for="save-dtype">Save DType</label>
            <select id="save-dtype" name="saveDtype">
              ${renderSelectOptions(SAVE_DTYPE_OPTIONS, process.save.dtype || 'bf16')}
            </select>
          </div>
        </div>
        <div class="panel">
          <div class="surface-header">
            <h3>Dataset</h3>
            <span class="badge">${escapeHtml(String(datasetOptions.length))} presets</span>
          </div>
          <div class="field">
            <label class="field-label" for="dataset-preset">Quick Pick</label>
            <select id="dataset-preset" name="datasetPreset" data-change="simple-dataset-preset">
              <option value="">Select a known dataset</option>
              ${datasetOptions.map((item) => `<option value="${escapeHtml(item.value)}" ${item.value === selectedDataset ? 'selected' : ''}>${escapeHtml(item.label)}</option>`).join('')}
            </select>
          </div>
          <div class="field">
            <label class="field-label" for="dataset-path">Dataset Folder</label>
            <input id="dataset-path" name="datasetPath" value="${escapeHtml(dataset.folder_path || '')}" placeholder="${escapeHtml(settings?.datasetsFolder || 'Dataset path')}">
          </div>
          <div class="simple-grid-3">
            <div class="field">
              <label class="field-label" for="caption-ext">Caption Ext</label>
              <input id="caption-ext" name="captionExt" value="${escapeHtml((dataset.caption_ext || 'txt').replace(/^\./, ''))}" placeholder="txt">
            </div>
            <div class="field">
              <label class="field-label" for="dataset-repeats">Repeats</label>
              <input id="dataset-repeats" name="datasetRepeats" type="number" min="1" value="${escapeHtml(dataset.num_repeats || 1)}">
            </div>
            <div class="field">
              <label class="field-label" for="caption-dropout">Caption Dropout</label>
              <input id="caption-dropout" name="captionDropout" type="number" step="0.01" min="0" max="1" value="${escapeHtml(dataset.caption_dropout_rate || 0)}">
            </div>
          </div>
          <div class="field">
            <label class="field-label" for="default-caption">Default Caption</label>
            <input id="default-caption" name="defaultCaption" value="${escapeHtml(dataset.default_caption || '')}" placeholder="Optional caption prefix">
          </div>
          <div class="field">
            <label class="field-label" for="dataset-resolution">Resolutions</label>
            <input id="dataset-resolution" name="datasetResolution" value="${escapeHtml((dataset.resolution || []).join(', '))}" placeholder="512, 768, 1024">
            <div class="field-help">Comma-separated values. This matches the old simple editor's common multi-resolution flow.</div>
          </div>
        </div>
        <div class="hero-panel simple-editor-wide">
          <div class="hero-line">
            <h3>Sampling</h3>
            <span class="badge info">One prompt per line</span>
          </div>
          <div class="simple-grid-3">
            <div class="field">
              <label class="field-label" for="sample-every">Sample Every</label>
              <input id="sample-every" name="sampleEvery" type="number" min="1" value="${escapeHtml(process.sample.sample_every)}">
            </div>
            <div class="field">
              <label class="field-label" for="sample-sampler">Sampler</label>
              <input id="sample-sampler" name="sampleSampler" value="${escapeHtml(process.sample.sampler || 'flowmatch')}">
            </div>
            <div class="field">
              <label class="field-label" for="guidance-scale">Guidance Scale</label>
              <input id="guidance-scale" name="guidanceScale" type="number" step="0.1" min="0" value="${escapeHtml(process.sample.guidance_scale)}">
            </div>
          </div>
          <div class="simple-grid-3">
            <div class="field">
              <label class="field-label" for="sample-width">Width</label>
              <input id="sample-width" name="sampleWidth" type="number" min="64" step="64" value="${escapeHtml(process.sample.width)}">
            </div>
            <div class="field">
              <label class="field-label" for="sample-height">Height</label>
              <input id="sample-height" name="sampleHeight" type="number" min="64" step="64" value="${escapeHtml(process.sample.height)}">
            </div>
            <div class="field">
              <label class="field-label" for="sample-steps">Sample Steps</label>
              <input id="sample-steps" name="sampleSteps" type="number" min="1" value="${escapeHtml(process.sample.sample_steps)}">
            </div>
          </div>
          <div class="simple-grid-3">
            <div class="field">
              <label class="field-label" for="sample-seed">Seed</label>
              <input id="sample-seed" name="sampleSeed" type="number" value="${escapeHtml(process.sample.seed)}">
            </div>
            <div class="field">
              <label class="field-label">Walk Seed</label>
              <label class="toggle-row">
                <input type="checkbox" name="walkSeed" ${process.sample.walk_seed ? 'checked' : ''}>
                <span>Offset seed per prompt</span>
              </label>
            </div>
            <div class="field">
              <label class="field-label">Mode Hint</label>
              <div class="field-help form-note">If you need per-sample width, height, seeds, or control images, switch to Advanced JSON.</div>
            </div>
          </div>
          <div class="field">
            <label class="field-label" for="sample-prompts">Sample Prompts</label>
            <textarea id="sample-prompts" class="simple-prompts" name="samplePrompts" spellcheck="false">${escapeHtml(samplePrompts)}</textarea>
            <div class="field-help">One prompt per line, just like the old simple workflow.</div>
          </div>
        </div>
        ${process.type === 'concept_slider' ? `
          <div class="panel simple-editor-wide">
            <div class="surface-header">
              <h3>Concept Slider</h3>
              <span class="badge warning">Slider mode</span>
            </div>
            <div class="simple-grid-3">
              <div class="field">
                <label class="field-label" for="slider-positive">Positive Prompt</label>
                <input id="slider-positive" name="sliderPositivePrompt" value="${escapeHtml(slider.positive_prompt || '')}">
              </div>
              <div class="field">
                <label class="field-label" for="slider-negative">Negative Prompt</label>
                <input id="slider-negative" name="sliderNegativePrompt" value="${escapeHtml(slider.negative_prompt || '')}">
              </div>
              <div class="field">
                <label class="field-label" for="slider-target">Target Class</label>
                <input id="slider-target" name="sliderTargetClass" value="${escapeHtml(slider.target_class || '')}">
              </div>
            </div>
            <div class="simple-grid-3">
              <div class="field">
                <label class="field-label" for="slider-anchor">Anchor Class</label>
                <input id="slider-anchor" name="sliderAnchorClass" value="${escapeHtml(slider.anchor_class || '')}">
              </div>
              <div class="field">
                <label class="field-label" for="slider-guidance">Guidance Strength</label>
                <input id="slider-guidance" name="sliderGuidanceStrength" type="number" step="0.1" min="0" value="${escapeHtml(slider.guidance_strength)}">
              </div>
              <div class="field">
                <label class="field-label" for="slider-anchor-strength">Anchor Strength</label>
                <input id="slider-anchor-strength" name="sliderAnchorStrength" type="number" step="0.1" min="0" value="${escapeHtml(slider.anchor_strength)}">
              </div>
            </div>
          </div>` : ''}
      </section>
      <div class="button-row">
        <button class="button" type="submit" name="submitAction" value="save">Save job</button>
        <button class="secondary-button" type="submit" name="submitAction" value="queue">Save and run queue</button>
        <button class="ghost-button" type="button" data-action="load-job-template">Starter template</button>
      </div>
    </form>
  `;
}

function renderGpuDataList(editor) {
  if (editor?.gpuInfo?.isMac) {
    return '<datalist id="gpu-id-options"><option value="mps">Apple GPU (mps)</option></datalist>';
  }

  const gpus = editor?.gpuInfo?.gpus || [];
  if (!gpus.length) {
    return '';
  }

  return `
    <datalist id="gpu-id-options">
      ${gpus.map((gpu) => `<option value="${escapeHtml(String(gpu.index))}">${escapeHtml(`GPU #${gpu.index} - ${gpu.name || 'GPU'}`)}</option>`).join('')}
    </datalist>
  `;
}

function renderJobDetailView() {
  const detail = state.jobDetail;
  if (!detail?.job) {
    return {
      title: 'Job Detail',
      subtitle: 'The selected job could not be loaded.',
      actions: topbarActions('<a class="ghost-button" href="#/jobs">Back to jobs</a>'),
      content: renderEmptyState('No job data available.'),
    };
  }

  const job = detail.job;
  const queue = detail.queues.find((item) => item.gpuIds === job.gpuIds);
  const progress = getJobProgress(job);

  return {
    title: job.name,
    subtitle: 'Live log, samples, loss metrics, and model files coming from the same training folder layout the old UI used.',
    actions: topbarActions(renderJobDetailActions(job, queue)),
    content: `
      <section class="detail-grid">
        <div class="panel">
          <div class="surface-header">
            <h3>Overview</h3>
            <div class="badge-row">
              ${renderStatusBadge(job.status)}
              <span class="badge">GPU ${escapeHtml(job.gpuIds)}</span>
            </div>
          </div>
          <div class="kv-grid">
            <div class="kv-item">
              <div class="kv-label">Progress</div>
              <div class="kv-value">${job.step} / ${progress.total || 'unknown'} steps</div>
              <div class="progress-track"><div class="progress-bar" style="width:${progress.percent}%"></div></div>
            </div>
            <div class="kv-item">
              <div class="kv-label">Queue State</div>
              <div class="kv-value">${queue?.isRunning ? 'Running' : 'Stopped'}</div>
            </div>
            <div class="kv-item">
              <div class="kv-label">Info</div>
              <div class="kv-value">${escapeHtml(job.info || 'No status info')}</div>
            </div>
            <div class="kv-item">
              <div class="kv-label">Updated</div>
              <div class="kv-value">${escapeHtml(formatDate(job.updatedAt))}</div>
            </div>
          </div>
        </div>
        <div class="panel">
          <div class="surface-header">
            <h3>Loss Metrics</h3>
            <div class="inline-actions">
              <select data-change="loss-key">
                ${(detail.loss?.keys || []).map((key) => `<option value="${escapeHtml(key)}" ${key === detail.lossKey ? 'selected' : ''}>${escapeHtml(key)}</option>`).join('')}
              </select>
            </div>
          </div>
          ${renderLossChart(detail.loss)}
        </div>
      </section>
      <section class="detail-grid" style="margin-top:18px;">
        <div class="panel">
          <div class="surface-header">
            <h3>Live Log</h3>
            <span class="badge info">${detail.log ? `${detail.log.length.toLocaleString()} chars` : 'empty'}</span>
          </div>
          <div id="job-live-log" class="log-block">${escapeHtml(detail.log || 'No log output yet.')}</div>
        </div>
        <div class="panel">
          <div class="surface-header">
            <h3>Model Files</h3>
            <span class="badge">${detail.files.length} files</span>
          </div>
          ${detail.files.length
            ? `<div class="stack">${detail.files.map((file) => `
                <div class="surface">
                  <div class="surface-header">
                    <div>
                      <div>${escapeHtml(file.path.split(/[\\/]/).pop())}</div>
                      <div class="field-help mono">${escapeHtml(file.path)}</div>
                    </div>
                    <a class="secondary-button" href="${fileUrl(file.path)}">Download</a>
                  </div>
                  <div class="field-help">${formatBytes(file.size)}</div>
                </div>`).join('')}</div>`
            : renderEmptyState('No model checkpoints found yet.')}
        </div>
      </section>
      <section class="panel" style="margin-top:18px;">
        <div class="surface-header">
          <h3>Samples</h3>
          <div class="inline-actions">
            <span class="badge">${detail.samples.length} assets</span>
            <button class="secondary-button" data-action="zip-samples" data-job-name="${escapeHtml(job.name)}">Build samples zip</button>
          </div>
        </div>
        ${detail.samples.length ? `<div class="gallery">${detail.samples.map((path) => renderSampleCard(path)).join('')}</div>` : renderEmptyState('No sample media has been emitted yet.')}
      </section>
    `,
  };
}

function renderDatasetsView() {
  const datasets = state.datasets;
  const selectedItem = datasets.images.find((item) => item.imgPath === datasets.selectedImage);
  return {
    title: 'Datasets',
    subtitle: 'Recursive media browse, caption sidecars, and direct uploads into either a dataset folder or the shared data/images pool.',
    actions: topbarActions(''),
    content: `
      <section class="dataset-layout">
        <div class="panel">
          <div class="surface-header">
            <h3>Dataset Folders</h3>
            <span class="badge">${datasets.list.length}</span>
          </div>
          <form id="dataset-create-form">
            <div class="field">
              <label class="field-label" for="dataset-name">New Dataset</label>
              <input id="dataset-name" name="name" placeholder="portrait_set_alpha" required>
            </div>
            <button class="button" type="submit">Create dataset</button>
          </form>
          <div class="dataset-list" style="margin-top:18px;">
            ${datasets.list.length ? datasets.list.map((name) => `
              <a class="dataset-link ${datasets.currentName === name ? 'active' : ''}" href="#/datasets/${encodeURIComponent(name)}">${escapeHtml(name)}</a>`).join('') : renderEmptyState('No dataset folders exist yet.')}
          </div>
        </div>
        <div class="stack">
          <div class="hero-panel">
            <div class="hero-line">
              <h3>${datasets.currentName ? escapeHtml(datasets.currentName) : 'Choose a dataset'}</h3>
              ${datasets.currentName ? `<div class="inline-actions">
                <button class="danger-button" data-action="delete-dataset" data-name="${escapeHtml(datasets.currentName)}">Delete dataset</button>
              </div>` : ''}
            </div>
            ${datasets.currentName ? `
              <div class="button-row">
                <form id="dataset-upload-form">
                  <input type="hidden" name="datasetName" value="${escapeHtml(datasets.currentName)}">
                  <div class="field">
                    <label class="field-label">Upload Into Dataset</label>
                    <input type="file" name="files" multiple required>
                  </div>
                  <button class="button" type="submit">Upload files</button>
                </form>
                <form id="stash-upload-form">
                  <div class="field">
                    <label class="field-label">Upload Into data/images</label>
                    <input type="file" name="files" multiple required>
                  </div>
                  <button class="secondary-button" type="submit">Upload stash files</button>
                </form>
              </div>` : renderEmptyState('Create or select a dataset to browse its media.')}
          </div>
          <div class="detail-grid">
            <div class="panel">
              <div class="surface-header">
                <h3>Media Grid</h3>
                <span class="badge">${datasets.images.length} items</span>
              </div>
              ${datasets.images.length ? `<div class="gallery">${datasets.images.map((item) => renderGalleryCard(item.imgPath, datasets.selectedImage)).join('')}</div>` : renderEmptyState('No media found in this dataset.')}
            </div>
            <div class="panel">
              <div class="surface-header">
                <h3>Caption Editor</h3>
                ${selectedItem ? '<span class="badge info">Sidecar .txt</span>' : ''}
              </div>
              ${selectedItem ? `
                <div class="preview-panel">
                  ${renderPreviewMedia(selectedItem.imgPath)}
                  <div class="field-help mono">${escapeHtml(selectedItem.imgPath)}</div>
                  <form id="caption-form">
                    <input type="hidden" name="imgPath" value="${escapeHtml(selectedItem.imgPath)}">
                    <div class="field">
                      <label class="field-label" for="caption-text">Caption</label>
                      <textarea id="caption-text" name="caption">${escapeHtml(datasets.caption || '')}</textarea>
                    </div>
                    <div class="button-row">
                      <button class="button" type="submit">Save caption</button>
                      <button class="danger-button" type="button" data-action="delete-image" data-path="${escapeHtml(selectedItem.imgPath)}">Delete asset</button>
                    </div>
                  </form>
                </div>` : renderEmptyState('Select an item to inspect it and edit its caption.')}
              ${datasets.stashUploads.length ? `
                <div class="surface" style="margin-top:18px;">
                  <div class="surface-header">
                    <h3>Latest Stash Uploads</h3>
                    <span class="badge">${datasets.stashUploads.length}</span>
                  </div>
                  <div class="stack">
                    ${datasets.stashUploads.map((path) => `
                      <div class="surface">
                        <div class="surface-header">
                          <div class="field-help mono">${escapeHtml(path)}</div>
                          <div class="inline-actions">
                            <a class="ghost-button" href="${mediaUrl(path)}" target="_blank" rel="noreferrer">Preview</a>
                            <button class="ghost-button" data-action="copy-text" data-text="${escapeHtml(path)}">Copy path</button>
                          </div>
                        </div>
                      </div>`).join('')}
                  </div>
                </div>` : ''}
            </div>
          </div>
        </div>
      </section>
    `,
  };
}

function renderSettingsView() {
  const settings = state.settings || {};
  return {
    title: 'Settings',
    subtitle: 'This page keeps only the path and token knobs that materially affect the backend worker and file layout.',
    actions: topbarActions(''),
    content: `
      <section class="editor-layout">
        <div class="panel">
          <div class="surface-header">
            <h3>Notes</h3>
            <span class="badge success">Low memory UI</span>
          </div>
          <div class="compact-stack">
            <div class="kv-item">
              <div class="kv-label">Backend Style</div>
              <div class="kv-value">ASP.NET Core minimal API, Native AOT project settings, static frontend files in <span class="mono">wwwroot</span>, and a background worker.</div>
            </div>
            <div class="kv-item">
              <div class="kv-label">Auth</div>
              <div class="kv-value">Set <span class="mono">AI_TOOLKIT_AUTH</span> to protect the API. Media download endpoints stay public to match the old UI behavior.</div>
            </div>
          </div>
        </div>
        <div class="hero-panel">
          <div class="hero-line">
            <h3>Runtime Settings</h3>
            <span class="badge info">Stored in aitk_db.db</span>
          </div>
          <form id="settings-form">
            <div class="field">
              <label class="field-label" for="hf-token">HF Token</label>
              <input id="hf-token" name="hfToken" value="${escapeHtml(settings.hfToken || '')}" placeholder="Optional Hugging Face token">
            </div>
            <div class="field">
              <label class="field-label" for="training-folder">Training Folder</label>
              <input id="training-folder" name="trainingFolder" value="${escapeHtml(settings.trainingFolder || '')}">
            </div>
            <div class="field">
              <label class="field-label" for="datasets-folder">Datasets Folder</label>
              <input id="datasets-folder" name="datasetsFolder" value="${escapeHtml(settings.datasetsFolder || '')}">
            </div>
            <div class="field">
              <label class="field-label" for="data-root">Data Root</label>
              <input id="data-root" name="dataRoot" value="${escapeHtml(settings.dataRoot || '')}">
            </div>
            <div class="button-row">
              <button class="button" type="submit">Save settings</button>
            </div>
          </form>
        </div>
      </section>
    `,
  };
}

function renderMetricCard(label, value, note) {
  return `
    <div class="metric-card">
      <div class="metric-label">${label}</div>
      <div class="metric-value">${escapeHtml(String(value))}</div>
      <div class="metric-note">${escapeHtml(note)}</div>
    </div>
  `;
}

function renderGpuQueueCards(gpuList, queues) {
  const queueMap = new Map(queues.map((queue) => [queue.gpuIds, queue]));
  const items = [];

  if (state.overview.gpu?.isMac) {
    const queue = queueMap.get('mps') || { gpuIds: 'mps', isRunning: false };
    items.push(renderSingleGpuCard({ index: 'mps', name: 'Apple GPU', memory: {}, utilization: {}, temperature: 0 }, queue));
  }

  for (const gpu of gpuList) {
    const queue = queueMap.get(String(gpu.index)) || { gpuIds: String(gpu.index), isRunning: false };
    items.push(renderSingleGpuCard(gpu, queue));
  }

  return items.length ? items.join('') : renderEmptyState('No GPU telemetry available.');
}

function renderSingleGpuCard(gpu, queue) {
  const queueAction = queue.isRunning
    ? `<button class="danger-button" data-action="stop-queue" data-queue="${escapeHtml(String(queue.gpuIds))}">Stop queue</button>`
    : `<button class="button" data-action="start-queue" data-queue="${escapeHtml(String(queue.gpuIds))}">Start queue</button>`;

  const used = gpu.memory?.used ?? 0;
  const total = gpu.memory?.total ?? 0;
  return `
    <div class="surface">
      <div class="surface-header">
        <div>
          <div>${escapeHtml(gpu.name || `GPU ${gpu.index}`)}</div>
          <div class="field-help">Queue ${escapeHtml(String(queue.gpuIds))}</div>
        </div>
        ${renderStatusBadge(queue.isRunning ? 'running' : 'stopped')}
      </div>
      <div class="kv-grid">
        <div class="kv-item">
          <div class="kv-label">GPU Load</div>
          <div class="kv-value">${formatNumber(gpu.utilization?.gpu)}%</div>
        </div>
        <div class="kv-item">
          <div class="kv-label">Memory</div>
          <div class="kv-value">${formatNumber(used)} / ${formatNumber(total)} MB</div>
        </div>
      </div>
      <div class="button-row" style="margin-top:14px;">${queueAction}</div>
    </div>
  `;
}

function renderCpuPanel(cpu) {
  if (!cpu) {
    return renderEmptyState('No CPU telemetry available.');
  }

  return `
    <div class="kv-grid">
      <div class="kv-item">
        <div class="kv-label">CPU</div>
        <div class="kv-value">${escapeHtml(cpu.name || 'Unknown')}</div>
      </div>
      <div class="kv-item">
        <div class="kv-label">Cores</div>
        <div class="kv-value">${escapeHtml(String(cpu.cores || 0))}</div>
      </div>
      <div class="kv-item">
        <div class="kv-label">Load</div>
        <div class="kv-value">${formatNumber(cpu.currentLoad)}%</div>
      </div>
      <div class="kv-item">
        <div class="kv-label">Memory</div>
        <div class="kv-value">${formatNumber(cpu.availableMemory)} / ${formatNumber(cpu.totalMemory)} MB free</div>
      </div>
    </div>
  `;
}

function renderJobsTable(jobs) {
  if (!jobs.length) {
    return renderEmptyState('No jobs found.');
  }

  return `
    <table class="table">
      <thead>
        <tr>
          <th>Name</th>
          <th>Progress</th>
          <th>GPU</th>
          <th>Status</th>
          <th>Info</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        ${jobs.map((job) => renderJobRow(job)).join('')}
      </tbody>
    </table>
  `;
}

function renderJobRow(job) {
  const progress = getJobProgress(job);
  return `
    <tr>
      <td>
        <div><a href="#/jobs/${encodeURIComponent(job.id)}">${escapeHtml(job.name)}</a></div>
        <div class="field-help mono">${escapeHtml(job.id)}</div>
      </td>
      <td>
        <div>${job.step} / ${progress.total || 'unknown'}</div>
        <div class="progress-track"><div class="progress-bar" style="width:${progress.percent}%"></div></div>
      </td>
      <td class="mono">${escapeHtml(job.gpuIds)}</td>
      <td>${renderStatusBadge(job.status)}</td>
      <td>${escapeHtml(job.info || '')}</td>
      <td><div class="inline-actions">${renderJobActions(job)}</div></td>
    </tr>
  `;
}
function renderJobActions(job) {
  const buttons = [`<a class="ghost-button" href="#/jobs/${encodeURIComponent(job.id)}">View</a>`];

  if (['stopped', 'completed', 'error'].includes(job.status)) {
    buttons.push(`<button class="button" data-action="job-start" data-id="${escapeHtml(job.id)}">Queue</button>`);
  }

  if (job.status === 'queued') {
    buttons.push(`<button class="secondary-button" data-action="job-remove-queue" data-id="${escapeHtml(job.id)}">Remove</button>`);
  }

  if (['running', 'stopping'].includes(job.status)) {
    buttons.push(`<button class="danger-button" data-action="job-stop" data-id="${escapeHtml(job.id)}">Stop</button>`);
  }

  buttons.push(`<a class="ghost-button" href="#/jobs/${encodeURIComponent(job.id)}/edit">Edit</a>`);
  buttons.push(`<a class="ghost-button" href="#/jobs/${encodeURIComponent(job.id)}/clone">Clone</a>`);
  buttons.push(`<button class="danger-button" data-action="job-delete" data-id="${escapeHtml(job.id)}">Delete</button>`);
  return buttons.join('');
}

function renderJobDetailActions(job, queue) {
  const actions = [];

  if (['stopped', 'completed', 'error'].includes(job.status)) {
    actions.push(`<button class="button" data-action="job-start" data-id="${escapeHtml(job.id)}">Queue job</button>`);
  }
  if (job.status === 'queued') {
    actions.push(`<button class="secondary-button" data-action="job-remove-queue" data-id="${escapeHtml(job.id)}">Remove from queue</button>`);
  }
  if (['running', 'stopping'].includes(job.status)) {
    actions.push(`<button class="danger-button" data-action="job-stop" data-id="${escapeHtml(job.id)}">Stop job</button>`);
  }

  actions.push(queue?.isRunning
    ? `<button class="danger-button" data-action="stop-queue" data-queue="${escapeHtml(job.gpuIds)}">Stop queue</button>`
    : `<button class="secondary-button" data-action="start-queue" data-queue="${escapeHtml(job.gpuIds)}">Start queue</button>`);
  actions.push(`<a class="ghost-button" href="#/jobs/${encodeURIComponent(job.id)}/edit">Edit</a>`);
  actions.push(`<a class="ghost-button" href="#/jobs/${encodeURIComponent(job.id)}/clone">Clone</a>`);
  actions.push(`<button class="danger-button" data-action="job-delete" data-id="${escapeHtml(job.id)}">Delete</button>`);
  return actions.join('');
}

function renderQueueBadges(queues) {
  return queues.map((queue) => `
    <span class="badge ${queue.isRunning ? 'success' : ''}">${escapeHtml(queue.gpuIds)} ${queue.isRunning ? 'running' : 'stopped'}</span>`).join('');
}

function renderStatusBadge(status) {
  const map = {
    running: 'success',
    queued: 'info',
    completed: 'success',
    stopped: 'warning',
    stopping: 'warning',
    error: 'danger',
  };
  const tone = map[status] || '';
  return `<span class="badge ${tone}">${escapeHtml(status)}</span>`;
}

function renderGalleryCard(path, activePath) {
  const isActive = activePath === path;
  return `
    <button class="gallery-card ${isActive ? 'active' : ''}" data-action="select-image" data-path="${escapeHtml(path)}">
      ${renderInlineMedia(path)}
    </button>
  `;
}

function renderSampleCard(path) {
  return `
    <a class="gallery-card" href="${mediaUrl(path)}" target="_blank" rel="noreferrer">
      ${renderInlineMedia(path)}
    </a>
  `;
}
function renderInlineMedia(path) {
  const ext = extensionOf(path);
  if (['.mp4', '.mov', '.avi', '.mkv', '.wmv', '.m4v', '.flv'].includes(ext)) {
    return `<video class="gallery-media" src="${mediaUrl(path)}" muted preload="metadata"></video>`;
  }
  if (['.mp3', '.wav'].includes(ext)) {
    return `<audio class="gallery-media" src="${mediaUrl(path)}" controls preload="none"></audio>`;
  }
  return `<img class="gallery-media" src="${mediaUrl(path)}" loading="lazy" alt="media asset">`;
}

function renderPreviewMedia(path) {
  const ext = extensionOf(path);
  if (['.mp4', '.mov', '.avi', '.mkv', '.wmv', '.m4v', '.flv'].includes(ext)) {
    return `<video class="preview-media" src="${mediaUrl(path)}" controls preload="metadata"></video>`;
  }
  if (['.mp3', '.wav'].includes(ext)) {
    return `<audio class="preview-media" src="${mediaUrl(path)}" controls preload="none"></audio>`;
  }
  return `<img class="preview-media" src="${mediaUrl(path)}" alt="preview">`;
}

function renderLossChart(loss) {
  const points = (loss?.points || []).filter((point) => typeof point.value === 'number');
  if (!points.length) {
    return renderEmptyState('No scalar loss points are available yet.');
  }

  const width = 800;
  const height = 220;
  const padding = 20;
  const values = points.map((point) => Number(point.value));
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const polyline = points.map((point, index) => {
    const x = padding + (index / Math.max(points.length - 1, 1)) * (width - padding * 2);
    const y = height - padding - ((Number(point.value) - min) / span) * (height - padding * 2);
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(' ');

  return `
    <div class="chart-shell">
      <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-label="Loss chart">
        <line x1="20" y1="20" x2="20" y2="200" stroke="rgba(255,255,255,0.16)"></line>
        <line x1="20" y1="200" x2="780" y2="200" stroke="rgba(255,255,255,0.16)"></line>
        <polyline fill="none" stroke="rgba(126,188,255,0.25)" stroke-width="12" stroke-linecap="round" stroke-linejoin="round" points="${polyline}"></polyline>
        <polyline fill="none" stroke="rgba(142,240,141,0.92)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" points="${polyline}"></polyline>
      </svg>
      <div class="chart-caption">
        <span>${escapeHtml(loss.key || 'loss')} � ${points.length} points</span>
        <span>min ${formatNumber(min)} / max ${formatNumber(max)}</span>
      </div>
    </div>
  `;
}

function renderLogin() {
  return `
    <div class="login-shell">
      <div class="login-panel">
        <div class="login-aside">
          <div class="brand-kicker">Protected API</div>
          <h1 style="margin:18px 0 10px; font-size:36px;">AI Toolkit Web</h1>
          <p>The backend checks <span class="mono">AI_TOOLKIT_AUTH</span> on every protected API request. Media routes stay public so logs, samples, and downloads still work once you are in.</p>
          <p>This replacement UI stores the token only in <span class="mono">localStorage</span> and sends it as a bearer token.</p>
        </div>
        <div class="login-main">
          <h2>Enter the token</h2>
          <p>Once it validates, the lightweight static frontend takes over and polls the backend directly.</p>
          <form id="login-form">
            <div class="field">
              <label class="field-label" for="login-token">Token</label>
              <input id="login-token" type="password" name="token" autocomplete="off" required>
            </div>
            <div class="button-row">
              <button class="button" type="submit">Check token</button>
            </div>
          </form>
        </div>
      </div>
    </div>
  `;
}

function renderLoadingState() {
  return `
    <div class="loading-state panel">
      <div class="loading-bar"></div>
      <div class="loading-bar"></div>
      <div class="loading-bar"></div>
    </div>
  `;
}

function renderEmptyState(message) {
  return `<div class="empty-state">${escapeHtml(message)}</div>`;
}

async function handleAction(action, target) {
  switch (action) {
    case 'refresh-route':
      await refreshRoute();
      return;
    case 'logout':
      localStorage.removeItem('AI_TOOLKIT_AUTH');
      state.authorized = false;
      clearPoller();
      render();
      return;
    case 'format-job-json': {
      const textarea = document.getElementById('job-config');
      if (textarea instanceof HTMLTextAreaElement) {
        const parsed = tryParseJson(textarea.value);
        if (!parsed) {
          showToast('JSON is invalid. Fix it first.', 'error');
          return;
        }
        const normalized = normalizeJobConfig(parsed);
        state.editor.jobConfig = stringifyJson(normalized);
        textarea.value = state.editor.jobConfig;
      }
      return;
    }
    case 'load-job-template': {
      const templateObject = createJobTemplateObject();
      if (!state.editor) {
        return;
      }
      state.editor.name = templateObject.config.name;
      state.editor.gpuIds = defaultGpuIds(state.editor.gpuInfo);
      state.editor.jobConfig = stringifyJson(templateObject);
      if (state.editor.viewMode === 'advanced') {
        const textarea = document.getElementById('job-config');
        if (textarea instanceof HTMLTextAreaElement) {
          textarea.value = state.editor.jobConfig;
        }
        const nameInput = document.getElementById('job-name');
        if (nameInput instanceof HTMLInputElement) {
          nameInput.value = state.editor.name;
        }
        const gpuInput = document.getElementById('job-gpus');
        if (gpuInput instanceof HTMLInputElement) {
          gpuInput.value = state.editor.gpuIds;
        }
      } else {
        render();
      }
      return;
    }
    case 'switch-job-editor-mode': {
      if (!state.editor) {
        return;
      }
      const nextMode = target.dataset.mode === 'advanced' ? 'advanced' : 'simple';
      if (state.editor.viewMode === nextMode) {
        return;
      }

      if (nextMode === 'advanced') {
        if (!syncSimpleEditorFromDom()) {
          return;
        }
      } else {
        const form = document.getElementById('job-editor-form');
        if (form instanceof HTMLFormElement) {
          const formData = new FormData(form);
          const parsed = tryParseJson(String(formData.get('jobConfig') || ''));
          if (!parsed) {
            showToast('JSON is invalid. Fix it first.', 'error');
            return;
          }
          state.editor.name = String(formData.get('name') || '').trim() || state.editor.name;
          state.editor.gpuIds = String(formData.get('gpuIds') || '').trim() || state.editor.gpuIds;
          state.editor.jobConfig = stringifyJson(normalizeJobConfig(parsed));
        }
      }

      state.editor.viewMode = nextMode;
      render();
      return;
    }
    case 'start-queue':
      await runAction(async () => {
        await fetchJson(`/api/queue/${encodeURIComponent(target.dataset.queue)}/start`);
        showToast(`Queue ${target.dataset.queue} started.`);
        await refreshRoute();
      });
      return;
    case 'stop-queue':
      await runAction(async () => {
        await fetchJson(`/api/queue/${encodeURIComponent(target.dataset.queue)}/stop`);
        showToast(`Queue ${target.dataset.queue} stopped.`);
        await refreshRoute();
      });
      return;
    case 'job-start':
      await runAction(async () => {
        const id = target.dataset.id;
        const job = await fetchJson(`/api/jobs/${encodeURIComponent(id)}/start`);
        await fetchJson(`/api/queue/${encodeURIComponent(job.gpuIds)}/start`);
        showToast('Job queued and queue started.');
        await refreshRoute();
      });
      return;
    case 'job-stop':
      if (!window.confirm('Stop this job?')) {
        return;
      }
      await runAction(async () => {
        await fetchJson(`/api/jobs/${encodeURIComponent(target.dataset.id)}/stop`);
        showToast('Stop requested.');
        await refreshRoute();
      });
      return;
    case 'job-remove-queue':
      await runAction(async () => {
        await fetchJson(`/api/jobs/${encodeURIComponent(target.dataset.id)}/mark_stopped`);
        showToast('Job removed from queue.');
        await refreshRoute();
      });
      return;
    case 'job-delete':
      if (!window.confirm('Delete this job and its training folder?')) {
        return;
      }
      await runAction(async () => {
        await fetchJson(`/api/jobs/${encodeURIComponent(target.dataset.id)}/delete`);
        showToast('Job deleted.');
        if (state.route?.mode === 'detail' && state.route.jobId === target.dataset.id) {
          window.location.hash = '#/jobs';
        } else {
          await refreshRoute();
        }
      });
      return;
    case 'zip-samples':
      await runAction(async () => {
        const payload = await fetchJson('/api/zip', {
          method: 'POST',
          json: { zipTarget: 'samples', jobName: target.dataset.jobName },
        });
        window.open(fileUrl(payload.zipPath), '_blank', 'noopener');
      });
      return;
    case 'select-image':
      await runAction(async () => {
        const imgPath = target.dataset.path;
        state.datasets.selectedImage = imgPath;
        state.datasets.caption = await fetchText('/api/caption/get', {
          method: 'POST',
          json: { imgPath },
        });
        render();
      }, false);
      return;
    case 'delete-image':
      if (!window.confirm('Delete this asset and its caption file?')) {
        return;
      }
      await runAction(async () => {
        await fetchJson('/api/img/delete', {
          method: 'POST',
          json: { imgPath: target.dataset.path },
        });
        showToast('Asset deleted.');
        await loadDatasets();
        render();
      });
      return;
    case 'delete-dataset':
      if (!window.confirm(`Delete dataset ${target.dataset.name}?`)) {
        return;
      }
      await runAction(async () => {
        await fetchJson('/api/datasets/delete', {
          method: 'POST',
          json: { name: target.dataset.name },
        });
        showToast('Dataset deleted.');
        window.location.hash = '#/datasets';
      });
      return;
    case 'copy-text':
      await navigator.clipboard.writeText(target.dataset.text || '');
      showToast('Copied to clipboard.');
      return;
    default:
      break;
  }
}

async function handleSubmit(form, submitter) {
  switch (form.id) {
    case 'login-form':
      await runAction(async () => {
        const formData = new FormData(form);
        const token = String(formData.get('token') || '');
        localStorage.setItem('AI_TOOLKIT_AUTH', token);
        await verifyAuth();
        if (!state.authorized) {
          localStorage.removeItem('AI_TOOLKIT_AUTH');
          showToast('Token rejected.', 'error');
          render();
          return;
        }
        showToast('Token accepted.');
        await refreshRoute();
      });
      return;
    case 'settings-form':
      await runAction(async () => {
        const formData = new FormData(form);
        await fetchJson('/api/settings', {
          method: 'POST',
          json: {
            hfToken: String(formData.get('hfToken') || ''),
            trainingFolder: String(formData.get('trainingFolder') || ''),
            datasetsFolder: String(formData.get('datasetsFolder') || ''),
            dataRoot: String(formData.get('dataRoot') || ''),
          },
        });
        showToast('Settings saved.');
        await refreshRoute();
      });
      return;
    case 'job-editor-form':
      await runAction(async () => {
        const formData = new FormData(form);
        const editor = state.editor;
        let name = String(formData.get('name') || '').trim();
        let gpuIds = String(formData.get('gpuIds') || '').trim();
        let jobConfig;

        if (editor?.viewMode === 'simple') {
          jobConfig = buildSimpleJobConfigFromForm(formData, editor?.jobConfig);
          if (state.editor) {
            state.editor.jobConfig = stringifyJson(jobConfig);
          }
        } else {
          const jobConfigText = String(formData.get('jobConfig') || '');
          const parsed = tryParseJson(jobConfigText);
          if (!parsed) {
            throw new Error('Job config JSON is invalid.');
          }
          jobConfig = normalizeJobConfig(parsed);
          if (state.editor) {
            state.editor.jobConfig = stringifyJson(jobConfig);
          }
        }

        name = name || jobConfig?.config?.name || editor?.name || '';
        gpuIds = gpuIds || editor?.gpuIds || defaultGpuIds(editor?.gpuInfo);
        if (!name) {
          throw new Error('Job name is required.');
        }

        jobConfig.config.name = name;
        if (state.editor) {
          state.editor.name = name;
          state.editor.gpuIds = gpuIds;
        }

        const saved = await fetchJson('/api/jobs', {
          method: 'POST',
          json: {
            id: String(formData.get('jobId') || '') || undefined,
            name,
            gpuIds,
            jobConfig,
          },
        });

        if (submitter?.value === 'queue') {
          await fetchJson(`/api/jobs/${encodeURIComponent(saved.id)}/start`);
          await fetchJson(`/api/queue/${encodeURIComponent(saved.gpuIds)}/start`);
          showToast('Job saved, queued, and queue started.');
        } else {
          showToast('Job saved.');
        }

        window.location.hash = `#/jobs/${encodeURIComponent(saved.id)}`;
      });
      return;
    case 'dataset-create-form':
      await runAction(async () => {
        const formData = new FormData(form);
        const payload = await fetchJson('/api/datasets/create', {
          method: 'POST',
          json: { name: String(formData.get('name') || '') },
        });
        showToast(`Dataset ${payload.name} created.`);
        window.location.hash = `#/datasets/${encodeURIComponent(payload.name)}`;
      });
      return;
    case 'dataset-upload-form':
      await runAction(async () => {
        const formData = new FormData(form);
        const response = await fetchJson('/api/datasets/upload', {
          method: 'POST',
          body: formData,
        });
        showToast(`${response.files?.length || 0} files uploaded.`);
        await loadDatasets();
        render();
      });
      return;
    case 'stash-upload-form':
      await runAction(async () => {
        const formData = new FormData(form);
        const response = await fetchJson('/api/img/upload', {
          method: 'POST',
          body: formData,
        });
        state.datasets.stashUploads = response.files || [];
        showToast(`${state.datasets.stashUploads.length} stash files uploaded.`);
        render();
      });
      return;
    case 'caption-form':
      await runAction(async () => {
        const formData = new FormData(form);
        await fetchJson('/api/img/caption', {
          method: 'POST',
          json: {
            imgPath: String(formData.get('imgPath') || ''),
            caption: String(formData.get('caption') || ''),
          },
        });
        showToast('Caption saved.');
      });
      return;
    default:
      return;
  }
}

async function runAction(fn, rerenderOnStart = true) {
  try {
    if (rerenderOnStart) {
      state.loading = true;
      render();
    }
    await fn();
  } catch (error) {
    console.error(error);
    showToast(error.message || 'Action failed.', 'error');
  } finally {
    if (rerenderOnStart) {
      state.loading = false;
      render();
    }
  }
}

async function fetchJson(url, options = {}) {
  const response = await apiFetch(url, options);
  if (!response.ok) {
    throw new Error(await readError(response));
  }
  return response.json();
}

async function fetchText(url, options = {}) {
  const response = await apiFetch(url, options);
  if (!response.ok) {
    throw new Error(await readError(response));
  }
  return response.text();
}

async function apiFetch(url, options = {}) {
  const init = { ...options };
  const headers = new Headers(init.headers || {});
  const token = localStorage.getItem('AI_TOOLKIT_AUTH');

  if (!options.allowAnonymous && token) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  if (options.json) {
    headers.set('Content-Type', 'application/json');
    init.body = JSON.stringify(options.json);
  }

  init.headers = headers;
  const response = await fetch(url, init);

  if (response.status === 401) {
    localStorage.removeItem('AI_TOOLKIT_AUTH');
    state.authorized = false;
    render();
  }

  return response;
}

async function readError(response) {
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    const payload = await response.json().catch(() => null);
    if (payload?.error) {
      return payload.error;
    }
  }

  const text = await response.text().catch(() => 'Request failed');
  return text || 'Request failed';
}

function showToast(message, tone = 'success') {
  const node = document.createElement('div');
  node.className = `toast ${tone}`;
  node.textContent = message;
  toastLayer.appendChild(node);
  window.setTimeout(() => {
    node.remove();
  }, 4000);
}

function normalizeJobs(payload) {
  return Array.isArray(payload) ? payload : payload?.jobs || [];
}

function normalizeQueues(payload) {
  return Array.isArray(payload) ? payload : payload?.queues || [];
}

function normalizeDatasets(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }
  return payload?.datasets || [];
}

function summarizeJobs(jobs) {
  return jobs.reduce((acc, job) => {
    acc[job.status] = (acc[job.status] || 0) + 1;
    return acc;
  }, { running: 0, queued: 0, completed: 0, error: 0, stopped: 0, stopping: 0 });
}

function getJobProgress(job) {
  const config = tryParseJson(job.jobConfig);
  const total = config?.config?.process?.[0]?.train?.steps || config?.config?.process?.[0]?.train?.max_train_steps || 0;
  const percent = total ? Math.max(0, Math.min(100, (job.step / total) * 100)) : 0;
  return { total, percent: percent.toFixed(1) };
}

const DEFAULT_DATASET_CONFIG = {
  folder_path: '/path/to/images/folder',
  mask_path: null,
  mask_min_value: 0.1,
  default_caption: '',
  caption_ext: 'txt',
  caption_dropout_rate: 0.05,
  cache_latents_to_disk: false,
  is_reg: false,
  network_weight: 1,
  resolution: [512, 768, 1024],
  controls: [],
  shrink_video_to_frames: true,
  num_frames: 1,
  flip_x: false,
  flip_y: false,
  num_repeats: 1,
};

const DEFAULT_SLIDER_CONFIG = {
  guidance_strength: 3,
  anchor_strength: 1,
  positive_prompt: 'person who is happy',
  negative_prompt: 'person who is sad',
  target_class: 'person',
  anchor_class: '',
};

const SIMPLE_MODEL_ARCH_OPTIONS = [
  {
    "value": "flux",
    "label": "FLUX.1",
    "group": "image",
    "disableQuantize": false,
    "defaults": {
      "config.process[0].model.name_or_path": "black-forest-labs/FLUX.1-dev",
      "config.process[0].model.quantize": true,
      "config.process[0].model.quantize_te": true,
      "config.process[0].sample.sampler": "flowmatch",
      "config.process[0].train.noise_scheduler": "flowmatch"
    }
  },
  {
    "value": "flux_kontext",
    "label": "FLUX.1-Kontext-dev",
    "group": "instruction",
    "disableQuantize": false,
    "defaults": {
      "config.process[0].model.name_or_path": "black-forest-labs/FLUX.1-Kontext-dev",
      "config.process[0].model.quantize": true,
      "config.process[0].model.quantize_te": true,
      "config.process[0].sample.sampler": "flowmatch",
      "config.process[0].train.noise_scheduler": "flowmatch",
      "config.process[0].train.timestep_type": "weighted"
    }
  },
  {
    "value": "flex1",
    "label": "Flex.1",
    "group": "image",
    "disableQuantize": false,
    "defaults": {
      "config.process[0].model.name_or_path": "ostris/Flex.1-alpha",
      "config.process[0].model.quantize": true,
      "config.process[0].model.quantize_te": true,
      "config.process[0].train.bypass_guidance_embedding": true,
      "config.process[0].sample.sampler": "flowmatch",
      "config.process[0].train.noise_scheduler": "flowmatch"
    }
  },
  {
    "value": "flex2",
    "label": "Flex.2",
    "group": "image",
    "disableQuantize": false,
    "defaults": {
      "config.process[0].model.name_or_path": "ostris/Flex.2-preview",
      "config.process[0].model.quantize": true,
      "config.process[0].model.quantize_te": true,
      "config.process[0].model.model_kwargs": {
        "invert_inpaint_mask_chance": 0.2,
        "inpaint_dropout": 0.5,
        "control_dropout": 0.5,
        "inpaint_random_chance": 0.2,
        "do_random_inpainting": true,
        "random_blur_mask": true,
        "random_dialate_mask": true
      },
      "config.process[0].train.bypass_guidance_embedding": true,
      "config.process[0].sample.sampler": "flowmatch",
      "config.process[0].train.noise_scheduler": "flowmatch"
    }
  },
  {
    "value": "chroma",
    "label": "Chroma",
    "group": "image",
    "disableQuantize": false,
    "defaults": {
      "config.process[0].model.name_or_path": "lodestones/Chroma1-Base",
      "config.process[0].model.quantize": true,
      "config.process[0].model.quantize_te": true,
      "config.process[0].sample.sampler": "flowmatch",
      "config.process[0].train.noise_scheduler": "flowmatch"
    }
  },
  {
    "value": "zeta_chroma",
    "label": "Zeta Chroma",
    "group": "experimental",
    "disableQuantize": false,
    "defaults": {
      "config.process[0].model.name_or_path": "lodestones/Zeta-Chroma/zeta-chroma-base-x0-pixel-dino-distance.safetensors",
      "config.process[0].model.extras_name_or_path": "Tongyi-MAI/Z-Image-Turbo",
      "config.process[0].model.quantize": true,
      "config.process[0].model.quantize_te": true,
      "config.process[0].sample.sampler": "flowmatch",
      "config.process[0].train.noise_scheduler": "flowmatch"
    }
  },
  {
    "value": "wan21:1b",
    "label": "Wan 2.1 (1.3B)",
    "group": "video",
    "disableQuantize": false,
    "defaults": {
      "config.process[0].model.name_or_path": "Wan-AI/Wan2.1-T2V-1.3B-Diffusers",
      "config.process[0].model.quantize": false,
      "config.process[0].model.quantize_te": true,
      "config.process[0].sample.sampler": "flowmatch",
      "config.process[0].train.noise_scheduler": "flowmatch",
      "config.process[0].sample.num_frames": 41,
      "config.process[0].sample.fps": 16
    }
  },
  {
    "value": "wan21_i2v:14b480p",
    "label": "Wan 2.1 I2V (14B-480P)",
    "group": "video",
    "disableQuantize": false,
    "defaults": {
      "config.process[0].model.name_or_path": "Wan-AI/Wan2.1-I2V-14B-480P-Diffusers",
      "config.process[0].model.quantize": true,
      "config.process[0].model.quantize_te": true,
      "config.process[0].sample.sampler": "flowmatch",
      "config.process[0].train.noise_scheduler": "flowmatch",
      "config.process[0].sample.num_frames": 41,
      "config.process[0].sample.fps": 16,
      "config.process[0].train.timestep_type": "weighted"
    }
  },
  {
    "value": "wan21_i2v:14b",
    "label": "Wan 2.1 I2V (14B-720P)",
    "group": "video",
    "disableQuantize": false,
    "defaults": {
      "config.process[0].model.name_or_path": "Wan-AI/Wan2.1-I2V-14B-720P-Diffusers",
      "config.process[0].model.quantize": true,
      "config.process[0].model.quantize_te": true,
      "config.process[0].sample.sampler": "flowmatch",
      "config.process[0].train.noise_scheduler": "flowmatch",
      "config.process[0].sample.num_frames": 41,
      "config.process[0].sample.fps": 16,
      "config.process[0].train.timestep_type": "weighted"
    }
  },
  {
    "value": "wan21:14b",
    "label": "Wan 2.1 (14B)",
    "group": "video",
    "disableQuantize": false,
    "defaults": {
      "config.process[0].model.name_or_path": "Wan-AI/Wan2.1-T2V-14B-Diffusers",
      "config.process[0].model.quantize": true,
      "config.process[0].model.quantize_te": true,
      "config.process[0].sample.sampler": "flowmatch",
      "config.process[0].train.noise_scheduler": "flowmatch",
      "config.process[0].sample.num_frames": 41,
      "config.process[0].sample.fps": 16
    }
  },
  {
    "value": "wan22_14b:t2v",
    "label": "Wan 2.2 (14B)",
    "group": "video",
    "disableQuantize": false,
    "defaults": {
      "config.process[0].model.name_or_path": "ai-toolkit/Wan2.2-T2V-A14B-Diffusers-bf16",
      "config.process[0].model.quantize": true,
      "config.process[0].model.quantize_te": true,
      "config.process[0].sample.sampler": "flowmatch",
      "config.process[0].train.noise_scheduler": "flowmatch",
      "config.process[0].sample.num_frames": 41,
      "config.process[0].sample.fps": 16,
      "config.process[0].model.low_vram": true,
      "config.process[0].train.timestep_type": "linear",
      "config.process[0].model.model_kwargs": {
        "train_high_noise": true,
        "train_low_noise": true
      }
    }
  },
  {
    "value": "wan22_14b_i2v",
    "label": "Wan 2.2 I2V (14B)",
    "group": "video",
    "disableQuantize": false,
    "defaults": {
      "config.process[0].model.name_or_path": "ai-toolkit/Wan2.2-I2V-A14B-Diffusers-bf16",
      "config.process[0].model.quantize": true,
      "config.process[0].model.quantize_te": true,
      "config.process[0].sample.sampler": "flowmatch",
      "config.process[0].train.noise_scheduler": "flowmatch",
      "config.process[0].sample.num_frames": 41,
      "config.process[0].sample.fps": 16,
      "config.process[0].model.low_vram": true,
      "config.process[0].train.timestep_type": "linear",
      "config.process[0].model.model_kwargs": {
        "train_high_noise": true,
        "train_low_noise": true
      }
    }
  },
  {
    "value": "wan22_5b",
    "label": "Wan 2.2 TI2V (5B)",
    "group": "video",
    "disableQuantize": false,
    "defaults": {
      "config.process[0].model.name_or_path": "Wan-AI/Wan2.2-TI2V-5B-Diffusers",
      "config.process[0].model.quantize": true,
      "config.process[0].model.quantize_te": true,
      "config.process[0].model.low_vram": true,
      "config.process[0].sample.sampler": "flowmatch",
      "config.process[0].train.noise_scheduler": "flowmatch",
      "config.process[0].sample.num_frames": 121,
      "config.process[0].sample.fps": 24,
      "config.process[0].sample.width": 768,
      "config.process[0].sample.height": 768,
      "config.process[0].train.timestep_type": "weighted",
      "config.process[0].datasets[x].do_i2v": true
    }
  },
  {
    "value": "lumina2",
    "label": "Lumina2",
    "group": "image",
    "disableQuantize": false,
    "defaults": {
      "config.process[0].model.name_or_path": "Alpha-VLLM/Lumina-Image-2.0",
      "config.process[0].model.quantize": false,
      "config.process[0].model.quantize_te": true,
      "config.process[0].sample.sampler": "flowmatch",
      "config.process[0].train.noise_scheduler": "flowmatch"
    }
  },
  {
    "value": "qwen_image",
    "label": "Qwen-Image",
    "group": "image",
    "disableQuantize": false,
    "defaults": {
      "config.process[0].model.name_or_path": "Qwen/Qwen-Image",
      "config.process[0].model.quantize": true,
      "config.process[0].model.quantize_te": true,
      "config.process[0].model.low_vram": true,
      "config.process[0].sample.sampler": "flowmatch",
      "config.process[0].train.noise_scheduler": "flowmatch",
      "config.process[0].train.timestep_type": "weighted",
      "config.process[0].model.qtype": "qfloat8"
    }
  },
  {
    "value": "qwen_image:2512",
    "label": "Qwen-Image-2512",
    "group": "image",
    "disableQuantize": false,
    "defaults": {
      "config.process[0].model.name_or_path": "Qwen/Qwen-Image-2512",
      "config.process[0].model.quantize": true,
      "config.process[0].model.quantize_te": true,
      "config.process[0].model.low_vram": true,
      "config.process[0].sample.sampler": "flowmatch",
      "config.process[0].train.noise_scheduler": "flowmatch",
      "config.process[0].train.timestep_type": "weighted",
      "config.process[0].model.qtype": "qfloat8"
    }
  },
  {
    "value": "qwen_image_edit",
    "label": "Qwen-Image-Edit",
    "group": "instruction",
    "disableQuantize": false,
    "defaults": {
      "config.process[0].model.name_or_path": "Qwen/Qwen-Image-Edit",
      "config.process[0].model.quantize": true,
      "config.process[0].model.quantize_te": true,
      "config.process[0].model.low_vram": true,
      "config.process[0].sample.sampler": "flowmatch",
      "config.process[0].train.noise_scheduler": "flowmatch",
      "config.process[0].train.timestep_type": "weighted",
      "config.process[0].model.qtype": "qfloat8"
    }
  },
  {
    "value": "qwen_image_edit_plus",
    "label": "Qwen-Image-Edit-2509",
    "group": "instruction",
    "disableQuantize": false,
    "defaults": {
      "config.process[0].model.name_or_path": "Qwen/Qwen-Image-Edit-2509",
      "config.process[0].model.quantize": true,
      "config.process[0].model.quantize_te": true,
      "config.process[0].model.low_vram": true,
      "config.process[0].train.unload_text_encoder": false,
      "config.process[0].sample.sampler": "flowmatch",
      "config.process[0].train.noise_scheduler": "flowmatch",
      "config.process[0].train.timestep_type": "weighted",
      "config.process[0].model.qtype": "qfloat8",
      "config.process[0].model.model_kwargs": {
        "match_target_res": false
      }
    }
  },
  {
    "value": "qwen_image_edit_plus:2511",
    "label": "Qwen-Image-Edit-2511",
    "group": "instruction",
    "disableQuantize": false,
    "defaults": {
      "config.process[0].model.name_or_path": "Qwen/Qwen-Image-Edit-2511",
      "config.process[0].model.quantize": true,
      "config.process[0].model.quantize_te": true,
      "config.process[0].model.low_vram": true,
      "config.process[0].train.unload_text_encoder": false,
      "config.process[0].sample.sampler": "flowmatch",
      "config.process[0].train.noise_scheduler": "flowmatch",
      "config.process[0].train.timestep_type": "weighted",
      "config.process[0].model.qtype": "qfloat8",
      "config.process[0].model.model_kwargs": {
        "match_target_res": false
      }
    }
  },
  {
    "value": "hidream",
    "label": "HiDream",
    "group": "image",
    "disableQuantize": false,
    "defaults": {
      "config.process[0].model.name_or_path": "HiDream-ai/HiDream-I1-Full",
      "config.process[0].model.quantize": true,
      "config.process[0].model.quantize_te": true,
      "config.process[0].sample.sampler": "flowmatch",
      "config.process[0].train.noise_scheduler": "flowmatch",
      "config.process[0].train.lr": 0.0002,
      "config.process[0].train.timestep_type": "shift",
      "config.process[0].network.network_kwargs.ignore_if_contains": [
        "ff_i.experts",
        "ff_i.gate"
      ]
    }
  },
  {
    "value": "hidream_e1",
    "label": "HiDream E1",
    "group": "instruction",
    "disableQuantize": false,
    "defaults": {
      "config.process[0].model.name_or_path": "HiDream-ai/HiDream-E1-1",
      "config.process[0].model.quantize": true,
      "config.process[0].model.quantize_te": true,
      "config.process[0].sample.sampler": "flowmatch",
      "config.process[0].train.noise_scheduler": "flowmatch",
      "config.process[0].train.lr": 0.0001,
      "config.process[0].train.timestep_type": "weighted",
      "config.process[0].network.network_kwargs.ignore_if_contains": [
        "ff_i.experts",
        "ff_i.gate"
      ]
    }
  },
  {
    "value": "sdxl",
    "label": "SDXL",
    "group": "image",
    "disableQuantize": true,
    "defaults": {
      "config.process[0].model.name_or_path": "stabilityai/stable-diffusion-xl-base-1.0",
      "config.process[0].model.quantize": false,
      "config.process[0].model.quantize_te": false,
      "config.process[0].sample.sampler": "ddpm",
      "config.process[0].train.noise_scheduler": "ddpm",
      "config.process[0].sample.guidance_scale": 6
    }
  },
  {
    "value": "sd15",
    "label": "SD 1.5",
    "group": "image",
    "disableQuantize": true,
    "defaults": {
      "config.process[0].model.name_or_path": "stable-diffusion-v1-5/stable-diffusion-v1-5",
      "config.process[0].sample.sampler": "ddpm",
      "config.process[0].train.noise_scheduler": "ddpm",
      "config.process[0].sample.width": 512,
      "config.process[0].sample.height": 512,
      "config.process[0].sample.guidance_scale": 6
    }
  },
  {
    "value": "omnigen2",
    "label": "OmniGen2",
    "group": "image",
    "disableQuantize": false,
    "defaults": {
      "config.process[0].model.name_or_path": "OmniGen2/OmniGen2",
      "config.process[0].sample.sampler": "flowmatch",
      "config.process[0].train.noise_scheduler": "flowmatch",
      "config.process[0].model.quantize": false,
      "config.process[0].model.quantize_te": true
    }
  },
  {
    "value": "flux2",
    "label": "FLUX.2",
    "group": "image",
    "disableQuantize": false,
    "defaults": {
      "config.process[0].model.name_or_path": "black-forest-labs/FLUX.2-dev",
      "config.process[0].model.quantize": true,
      "config.process[0].model.quantize_te": true,
      "config.process[0].model.low_vram": true,
      "config.process[0].train.unload_text_encoder": false,
      "config.process[0].sample.sampler": "flowmatch",
      "config.process[0].train.noise_scheduler": "flowmatch",
      "config.process[0].train.timestep_type": "weighted",
      "config.process[0].model.qtype": "qfloat8",
      "config.process[0].model.model_kwargs": {
        "match_target_res": false
      }
    }
  },
  {
    "value": "zimage:turbo",
    "label": "Z-Image Turbo (w/ Training Adapter)",
    "group": "image",
    "disableQuantize": false,
    "defaults": {
      "config.process[0].model.name_or_path": "Tongyi-MAI/Z-Image-Turbo",
      "config.process[0].model.quantize": true,
      "config.process[0].model.quantize_te": true,
      "config.process[0].model.low_vram": true,
      "config.process[0].train.unload_text_encoder": false,
      "config.process[0].sample.sampler": "flowmatch",
      "config.process[0].train.noise_scheduler": "flowmatch",
      "config.process[0].train.timestep_type": "weighted",
      "config.process[0].model.qtype": "qfloat8",
      "config.process[0].model.assistant_lora_path": "ostris/zimage_turbo_training_adapter/zimage_turbo_training_adapter_v2.safetensors",
      "config.process[0].sample.guidance_scale": 1,
      "config.process[0].sample.sample_steps": 8
    }
  },
  {
    "value": "zimage",
    "label": "Z-Image",
    "group": "image",
    "disableQuantize": false,
    "defaults": {
      "config.process[0].model.name_or_path": "Tongyi-MAI/Z-Image",
      "config.process[0].model.quantize": true,
      "config.process[0].model.quantize_te": true,
      "config.process[0].model.low_vram": true,
      "config.process[0].train.unload_text_encoder": false,
      "config.process[0].sample.sampler": "flowmatch",
      "config.process[0].train.noise_scheduler": "flowmatch",
      "config.process[0].train.timestep_type": "weighted",
      "config.process[0].model.qtype": "qfloat8",
      "config.process[0].sample.sample_steps": 30
    }
  },
  {
    "value": "zimage:deturbo",
    "label": "Z-Image De-Turbo (De-Distilled)",
    "group": "image",
    "disableQuantize": false,
    "defaults": {
      "config.process[0].model.name_or_path": "ostris/Z-Image-De-Turbo",
      "config.process[0].model.extras_name_or_path": "Tongyi-MAI/Z-Image-Turbo",
      "config.process[0].model.quantize": true,
      "config.process[0].model.quantize_te": true,
      "config.process[0].model.low_vram": true,
      "config.process[0].train.unload_text_encoder": false,
      "config.process[0].sample.sampler": "flowmatch",
      "config.process[0].train.noise_scheduler": "flowmatch",
      "config.process[0].train.timestep_type": "weighted",
      "config.process[0].model.qtype": "qfloat8",
      "config.process[0].sample.guidance_scale": 3,
      "config.process[0].sample.sample_steps": 25
    }
  },
  {
    "value": "ltx2",
    "label": "LTX-2",
    "group": "video",
    "disableQuantize": false,
    "defaults": {
      "config.process[0].model.name_or_path": "Lightricks/LTX-2",
      "config.process[0].model.quantize": true,
      "config.process[0].model.quantize_te": true,
      "config.process[0].model.low_vram": true,
      "config.process[0].sample.sampler": "flowmatch",
      "config.process[0].train.noise_scheduler": "flowmatch",
      "config.process[0].sample.num_frames": 121,
      "config.process[0].sample.fps": 24,
      "config.process[0].sample.width": 768,
      "config.process[0].sample.height": 768,
      "config.process[0].train.audio_loss_multiplier": 1,
      "config.process[0].train.timestep_type": "weighted",
      "config.process[0].datasets[x].do_i2v": false,
      "config.process[0].datasets[x].do_audio": true,
      "config.process[0].datasets[x].fps": 24,
      "config.process[0].datasets[x].auto_frame_count": false
    }
  },
  {
    "value": "ltx2.3",
    "label": "LTX-2.3",
    "group": "video",
    "disableQuantize": false,
    "defaults": {
      "config.process[0].model.name_or_path": "Lightricks/LTX-2.3/ltx-2.3-22b-dev.safetensors",
      "config.process[0].model.quantize": true,
      "config.process[0].model.quantize_te": true,
      "config.process[0].model.low_vram": true,
      "config.process[0].sample.sampler": "flowmatch",
      "config.process[0].train.noise_scheduler": "flowmatch",
      "config.process[0].sample.num_frames": 121,
      "config.process[0].sample.fps": 24,
      "config.process[0].sample.width": 768,
      "config.process[0].sample.height": 768,
      "config.process[0].train.audio_loss_multiplier": 1,
      "config.process[0].train.timestep_type": "weighted",
      "config.process[0].datasets[x].cache_latents_to_disk": true,
      "config.process[0].datasets[x].do_i2v": false,
      "config.process[0].datasets[x].do_audio": true,
      "config.process[0].datasets[x].fps": 24,
      "config.process[0].datasets[x].auto_frame_count": false
    }
  },
  {
    "value": "flux2_klein_4b",
    "label": "FLUX.2-klein-base-4B",
    "group": "image",
    "disableQuantize": false,
    "defaults": {
      "config.process[0].model.name_or_path": "black-forest-labs/FLUX.2-klein-base-4B",
      "config.process[0].model.quantize": true,
      "config.process[0].model.quantize_te": true,
      "config.process[0].model.low_vram": true,
      "config.process[0].train.unload_text_encoder": false,
      "config.process[0].sample.sampler": "flowmatch",
      "config.process[0].train.noise_scheduler": "flowmatch",
      "config.process[0].train.timestep_type": "weighted",
      "config.process[0].model.qtype": "qfloat8",
      "config.process[0].model.model_kwargs": {
        "match_target_res": false
      }
    }
  },
  {
    "value": "flux2_klein_9b",
    "label": "FLUX.2-klein-base-9B",
    "group": "image",
    "disableQuantize": false,
    "defaults": {
      "config.process[0].model.name_or_path": "black-forest-labs/FLUX.2-klein-base-9B",
      "config.process[0].model.quantize": true,
      "config.process[0].model.quantize_te": true,
      "config.process[0].model.low_vram": true,
      "config.process[0].train.unload_text_encoder": false,
      "config.process[0].sample.sampler": "flowmatch",
      "config.process[0].train.noise_scheduler": "flowmatch",
      "config.process[0].train.timestep_type": "weighted",
      "config.process[0].model.qtype": "qfloat8",
      "config.process[0].model.model_kwargs": {
        "match_target_res": false
      }
    }
  }
];

const SIMPLE_JOB_TYPE_OPTIONS = [
  { value: 'diffusion_trainer', label: 'LoRA Trainer' },
  { value: 'concept_slider', label: 'Concept Slider' },
];

const QUANTIZATION_OPTIONS = [
  { value: '', label: '- NONE -' },
  { value: 'qfloat8', label: 'float8 (default)' },
  { value: 'uint7', label: '7 bit' },
  { value: 'uint6', label: '6 bit' },
  { value: 'uint5', label: '5 bit' },
  { value: 'uint4', label: '4 bit' },
  { value: 'uint3', label: '3 bit' },
  { value: 'uint2', label: '2 bit' },
];

const SAVE_DTYPE_OPTIONS = [
  { value: 'bf16', label: 'bf16' },
  { value: 'fp16', label: 'fp16' },
  { value: 'fp32', label: 'fp32' },
];

function createJobTemplateObject() {
  return {
    job: 'extension',
    config: {
      name: 'my_first_lora_v1',
      process: [
        {
          type: 'diffusion_trainer',
          training_folder: 'output',
          sqlite_db_path: './aitk_db.db',
          device: state.editor?.gpuInfo?.isMac || state.overview.gpu?.isMac ? 'mps' : 'cuda',
          trigger_word: null,
          performance_log_every: 10,
          network: {
            type: 'lora',
            linear: 32,
            linear_alpha: 32,
            conv: 16,
            conv_alpha: 16,
            lokr_full_rank: true,
            lokr_factor: -1,
            network_kwargs: {
              ignore_if_contains: [],
            },
          },
          save: {
            dtype: 'bf16',
            save_every: 250,
            max_step_saves_to_keep: 4,
            save_format: 'diffusers',
            push_to_hub: false,
          },
          datasets: [cloneValue(DEFAULT_DATASET_CONFIG)],
          train: {
            batch_size: 1,
            bypass_guidance_embedding: true,
            steps: 3000,
            gradient_accumulation: 1,
            train_unet: true,
            train_text_encoder: false,
            gradient_checkpointing: true,
            noise_scheduler: 'flowmatch',
            optimizer: 'adamw8bit',
            timestep_type: 'sigmoid',
            content_or_style: 'balanced',
            optimizer_params: {
              weight_decay: 0.0001,
            },
            unload_text_encoder: false,
            cache_text_embeddings: false,
            lr: 0.0001,
            ema_config: {
              use_ema: false,
              ema_decay: 0.99,
            },
            skip_first_sample: false,
            force_first_sample: false,
            disable_sampling: false,
            dtype: 'bf16',
            diff_output_preservation: false,
            diff_output_preservation_multiplier: 1,
            diff_output_preservation_class: 'person',
            switch_boundary_every: 1,
            loss_type: 'mse',
          },
          logging: {
            log_every: 1,
            use_ui_logger: true,
          },
          model: {
            name_or_path: 'ostris/Flex.1-alpha',
            quantize: true,
            qtype: 'qfloat8',
            quantize_te: true,
            qtype_te: 'qfloat8',
            arch: 'flex1',
            low_vram: false,
            model_kwargs: {},
          },
          sample: {
            sampler: 'flowmatch',
            sample_every: 250,
            width: 1024,
            height: 1024,
            samples: [
              { prompt: 'woman with red hair, playing chess at the park, bomb going off in the background' },
              { prompt: 'a woman holding a coffee cup, in a beanie, sitting at a cafe' },
              { prompt: 'a horse is a DJ at a night club, fish eye lens, smoke machine, lazer lights, holding a martini' },
              { prompt: 'a man showing off his cool new t shirt at the beach, a shark is jumping out of the water in the background' },
            ],
            neg: '',
            seed: 42,
            walk_seed: true,
            guidance_scale: 4,
            sample_steps: 25,
            num_frames: 1,
            fps: 1,
          },
        },
      ],
    },
    meta: {
      name: '[name]',
      version: '1.0',
    },
  };
}

function createJobTemplate() {
  return stringifyJson(createJobTemplateObject());
}

function getEditorConfig(editor) {
  return normalizeJobConfig(tryParseJson(editor?.jobConfig || '') || createJobTemplateObject());
}

function normalizeJobConfig(value) {
  const template = createJobTemplateObject();
  const config = value && typeof value === 'object' ? cloneValue(value) : createJobTemplateObject();

  config.job = config.job || template.job;
  config.config = config.config || {};
  config.config.name = config.config.name || template.config.name;
  if (!Array.isArray(config.config.process) || !config.config.process.length) {
    config.config.process = [cloneValue(template.config.process[0])];
  }

  const process = config.config.process[0];
  const templateProcess = template.config.process[0];
  process.type = process.type || templateProcess.type;
  process.training_folder = process.training_folder || templateProcess.training_folder;
  process.sqlite_db_path = process.sqlite_db_path || templateProcess.sqlite_db_path;
  process.device = state.editor?.gpuInfo?.isMac || state.overview.gpu?.isMac ? 'mps' : process.device || templateProcess.device;
  process.performance_log_every = process.performance_log_every ?? templateProcess.performance_log_every;
  process.trigger_word = typeof process.trigger_word === 'string' && process.trigger_word.trim() ? process.trigger_word : null;
  process.network = { ...templateProcess.network, ...(process.network || {}) };
  process.network.network_kwargs = { ...templateProcess.network.network_kwargs, ...(process.network?.network_kwargs || {}) };
  process.save = { ...templateProcess.save, ...(process.save || {}) };
  process.train = { ...templateProcess.train, ...(process.train || {}) };
  process.train.optimizer_params = { ...templateProcess.train.optimizer_params, ...(process.train?.optimizer_params || {}) };
  process.train.ema_config = { ...templateProcess.train.ema_config, ...(process.train?.ema_config || {}) };
  process.logging = { ...templateProcess.logging, ...(process.logging || {}) };
  process.model = { ...templateProcess.model, ...(process.model || {}) };
  process.model.model_kwargs = { ...templateProcess.model.model_kwargs, ...(process.model?.model_kwargs || {}) };

  if (Array.isArray(process.sample?.prompts) && (!Array.isArray(process.sample.samples) || !process.sample.samples.length)) {
    process.sample.samples = process.sample.prompts.map((prompt) => ({ prompt }));
    delete process.sample.prompts;
  }

  process.sample = { ...templateProcess.sample, ...(process.sample || {}) };
  process.sample.samples = Array.isArray(process.sample.samples)
    ? process.sample.samples.map((sample) => normalizeSampleEntry(sample))
    : cloneValue(templateProcess.sample.samples);

  process.datasets = Array.isArray(process.datasets) && process.datasets.length
    ? process.datasets.map((dataset) => normalizeDatasetConfig(dataset))
    : [cloneValue(DEFAULT_DATASET_CONFIG)];

  if (process.type === 'concept_slider') {
    process.slider = { ...DEFAULT_SLIDER_CONFIG, ...(process.slider || {}) };
  }

  config.meta = { ...template.meta, ...(config.meta || {}) };
  return config;
}

function normalizeSampleEntry(sample) {
  return {
    ...(sample || {}),
    prompt: String(sample?.prompt || ''),
  };
}

function normalizeDatasetConfig(dataset) {
  const normalized = { ...cloneValue(DEFAULT_DATASET_CONFIG), ...(dataset || {}) };
  normalized.caption_ext = String(normalized.caption_ext || 'txt').replace(/^\./, '');
  normalized.resolution = Array.isArray(normalized.resolution) && normalized.resolution.length
    ? normalized.resolution.map((value) => parseInt(value, 10)).filter((value) => Number.isFinite(value) && value > 0)
    : cloneValue(DEFAULT_DATASET_CONFIG.resolution);
  normalized.num_repeats = Number.isFinite(Number(normalized.num_repeats)) ? Number(normalized.num_repeats) : 1;
  normalized.caption_dropout_rate = Number.isFinite(Number(normalized.caption_dropout_rate)) ? Number(normalized.caption_dropout_rate) : 0;
  return normalized;
}

function cloneValue(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function renderSelectOptions(options, selectedValue) {
  return options.map((option) => `<option value="${escapeHtml(option.value)}" ${option.value === selectedValue ? 'selected' : ''}>${escapeHtml(option.label)}</option>`).join('');
}

function renderModelArchOptions(selectedValue) {
  const order = ['image', 'instruction', 'video', 'experimental'];
  return order
    .map((group) => {
      const items = SIMPLE_MODEL_ARCH_OPTIONS.filter((option) => option.group === group);
      if (!items.length) {
        return '';
      }
      return `<optgroup label="${escapeHtml(group)}">${renderSelectOptions(items, selectedValue)}</optgroup>`;
    })
    .join('');
}

function getSimpleModelOption(value) {
  return SIMPLE_MODEL_ARCH_OPTIONS.find((option) => option.value === value) || null;
}

function applyModelDefaults(target, defaults) {
  for (const [path, value] of Object.entries(defaults || {})) {
    setNestedValueByPath(target, path, cloneValue(value));
  }
}

function setNestedValueByPath(target, path, value) {
  const normalizedPath = String(path).replaceAll('[x]', '[0]');
  const segments = normalizedPath.match(/[^.[\]]+|\[(\d+)\]/g) || [];
  let current = target;

  for (let index = 0; index < segments.length; index += 1) {
    const rawSegment = segments[index];
    const key = rawSegment.startsWith('[') ? Number.parseInt(rawSegment.slice(1, -1), 10) : rawSegment;
    const isLast = index === segments.length - 1;

    if (isLast) {
      current[key] = value;
      return;
    }

    const nextSegment = segments[index + 1];
    const nextIsArray = nextSegment.startsWith('[');
    if (current[key] == null) {
      current[key] = nextIsArray ? [] : {};
    }
    current = current[key];
  }
}

function buildDatasetOptions(datasetNames, settings) {
  const base = settings?.datasetsFolder || '';
  return (datasetNames || []).map((name) => ({
    label: name,
    value: combinePath(base, name),
  }));
}

function combinePath(base, leaf) {
  if (!base) {
    return leaf;
  }
  const separator = base.includes('\\') ? '\\' : '/';
  return `${String(base).replace(/[\\/]+$/, '')}${separator}${leaf}`;
}

function syncSimpleEditorFromDom() {
  const form = document.getElementById('job-editor-form');
  if (!(form instanceof HTMLFormElement) || state.editor?.viewMode !== 'simple') {
    return true;
  }

  try {
    const formData = new FormData(form);
    const jobConfig = buildSimpleJobConfigFromForm(formData, state.editor?.jobConfig);
    state.editor.name = String(formData.get('name') || '').trim() || jobConfig.config.name || state.editor.name;
    state.editor.gpuIds = String(formData.get('gpuIds') || '').trim() || defaultGpuIds(state.editor.gpuInfo);
    state.editor.jobConfig = stringifyJson(jobConfig);
    return true;
  } catch (error) {
    showToast(error.message || 'Could not sync the simple editor.', 'error');
    return false;
  }
}

function applySimpleModelArch(arch) {
  if (!state.editor) {
    return;
  }

  const option = getSimpleModelOption(arch);
  if (!option) {
    return;
  }

  const jobConfig = getEditorConfig(state.editor);
  const process = jobConfig.config.process[0];
  process.model.arch = option.value;
  applyModelDefaults(jobConfig, option.defaults);

  if (option.disableQuantize) {
    process.model.quantize = false;
    process.model.quantize_te = false;
  }

  state.editor.jobConfig = stringifyJson(normalizeJobConfig(jobConfig));
}

function applySimpleJobType(type) {
  if (!state.editor) {
    return;
  }

  const jobConfig = getEditorConfig(state.editor);
  const process = jobConfig.config.process[0];
  process.type = type || 'diffusion_trainer';
  if (process.type === 'concept_slider') {
    process.slider = { ...DEFAULT_SLIDER_CONFIG, ...(process.slider || {}) };
  } else {
    delete process.slider;
  }

  state.editor.jobConfig = stringifyJson(jobConfig);
}

function buildSimpleJobConfigFromForm(formData, baseConfigSource) {
  const parsedBase = typeof baseConfigSource === 'string' ? tryParseJson(baseConfigSource) : baseConfigSource;
  const jobConfig = normalizeJobConfig(parsedBase);
  const process = jobConfig.config.process[0];
  const gpuIds = String(formData.get('gpuIds') || state.editor?.gpuIds || defaultGpuIds(state.editor?.gpuInfo)).trim();

  jobConfig.config.name = String(formData.get('name') || jobConfig.config.name || '').trim() || jobConfig.config.name;
  process.type = String(formData.get('jobType') || process.type || 'diffusion_trainer');
  process.trigger_word = blankToNull(formData.get('triggerWord'));
  process.model.arch = String(formData.get('modelArch') || process.model.arch || 'flex1');
  process.model.name_or_path = String(formData.get('modelNameOrPath') || process.model.name_or_path || '').trim();

  const transformerQuant = String(formData.get('transformerQuant') || (process.model.quantize ? process.model.qtype : ''));
  process.model.quantize = transformerQuant !== '';
  process.model.qtype = transformerQuant || 'qfloat8';

  const textEncoderQuant = String(formData.get('textEncoderQuant') || (process.model.quantize_te ? process.model.qtype_te : ''));
  process.model.quantize_te = textEncoderQuant !== '';
  process.model.qtype_te = textEncoderQuant || 'qfloat8';
  process.model.low_vram = formData.get('lowVram') === 'on';

  process.train.steps = parseInteger(formData.get('steps'), process.train.steps, 1);
  process.train.batch_size = parseInteger(formData.get('batchSize'), process.train.batch_size, 1);
  process.train.gradient_accumulation = parseInteger(formData.get('gradAccum'), process.train.gradient_accumulation, 1);
  process.train.lr = parseFloatValue(formData.get('learningRate'), process.train.lr, 0.0001);

  process.save.dtype = String(formData.get('saveDtype') || process.save.dtype || 'bf16');
  process.save.save_every = parseInteger(formData.get('saveEvery'), process.save.save_every, 1);
  process.save.max_step_saves_to_keep = parseInteger(formData.get('maxSaves'), process.save.max_step_saves_to_keep, 1);

  const dataset = normalizeDatasetConfig(process.datasets[0]);
  dataset.folder_path = String(formData.get('datasetPath') || '').trim() || dataset.folder_path;
  dataset.caption_ext = String(formData.get('captionExt') || dataset.caption_ext || 'txt').replace(/^\./, '');
  dataset.num_repeats = parseInteger(formData.get('datasetRepeats'), dataset.num_repeats, 1);
  dataset.caption_dropout_rate = parseFloatValue(formData.get('captionDropout'), dataset.caption_dropout_rate, 0);
  dataset.default_caption = String(formData.get('defaultCaption') || dataset.default_caption || '');
  dataset.resolution = parseResolutionList(formData.get('datasetResolution'), dataset.resolution);
  process.datasets[0] = dataset;

  process.sample.sample_every = parseInteger(formData.get('sampleEvery'), process.sample.sample_every, 1);
  process.sample.sampler = String(formData.get('sampleSampler') || process.sample.sampler || 'flowmatch');
  process.sample.width = parseInteger(formData.get('sampleWidth'), process.sample.width, 64);
  process.sample.height = parseInteger(formData.get('sampleHeight'), process.sample.height, 64);
  process.sample.guidance_scale = parseFloatValue(formData.get('guidanceScale'), process.sample.guidance_scale, 0);
  process.sample.sample_steps = parseInteger(formData.get('sampleSteps'), process.sample.sample_steps, 1);
  process.sample.seed = parseInteger(formData.get('sampleSeed'), process.sample.seed, 0);
  process.sample.walk_seed = formData.get('walkSeed') === 'on';
  process.sample.samples = parsePromptSamples(formData.get('samplePrompts'));

  if (process.type === 'concept_slider') {
    process.slider = {
      ...DEFAULT_SLIDER_CONFIG,
      ...(process.slider || {}),
      positive_prompt: String(formData.get('sliderPositivePrompt') || process.slider?.positive_prompt || DEFAULT_SLIDER_CONFIG.positive_prompt),
      negative_prompt: String(formData.get('sliderNegativePrompt') || process.slider?.negative_prompt || DEFAULT_SLIDER_CONFIG.negative_prompt),
      target_class: String(formData.get('sliderTargetClass') || process.slider?.target_class || DEFAULT_SLIDER_CONFIG.target_class),
      anchor_class: String(formData.get('sliderAnchorClass') || process.slider?.anchor_class || DEFAULT_SLIDER_CONFIG.anchor_class),
      guidance_strength: parseFloatValue(formData.get('sliderGuidanceStrength'), process.slider?.guidance_strength, DEFAULT_SLIDER_CONFIG.guidance_strength),
      anchor_strength: parseFloatValue(formData.get('sliderAnchorStrength'), process.slider?.anchor_strength, DEFAULT_SLIDER_CONFIG.anchor_strength),
    };
  } else {
    delete process.slider;
  }

  const modelOption = getSimpleModelOption(process.model.arch);
  if (modelOption) {
    const defaultModelName = modelOption.defaults?.['config.process[0].model.name_or_path'];
    if (!process.model.name_or_path && defaultModelName) {
      process.model.name_or_path = defaultModelName;
    }
    if (modelOption.disableQuantize) {
      process.model.quantize = false;
      process.model.quantize_te = false;
    }
  }

  process.device = gpuIds === 'mps' || state.editor?.gpuInfo?.isMac ? 'mps' : process.device || 'cuda';
  return jobConfig;
}

function blankToNull(value) {
  const text = String(value || '').trim();
  return text ? text : null;
}

function parseResolutionList(value, fallback) {
  const numbers = String(value || '')
    .split(',')
    .map((item) => parseInt(item.trim(), 10))
    .filter((item) => Number.isFinite(item) && item > 0);

  return numbers.length ? numbers : cloneValue(fallback || DEFAULT_DATASET_CONFIG.resolution);
}

function parsePromptSamples(value) {
  return String(value || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((prompt) => ({ prompt }));
}

function parseInteger(value, fallback, minValue) {
  const numeric = parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  if (Number.isFinite(minValue)) {
    return Math.max(minValue, numeric);
  }
  return numeric;
}

function parseFloatValue(value, fallback, minValue) {
  const numeric = parseFloat(String(value ?? ''));
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  if (Number.isFinite(minValue)) {
    return Math.max(minValue, numeric);
  }
  return numeric;
}

function defaultGpuIds(gpuInfo = null) {
  const info = gpuInfo || state.editor?.gpuInfo || state.overview.gpu;
  if (info?.isMac) {
    return 'mps';
  }

  const firstGpu = info?.gpus?.[0];
  return firstGpu ? String(firstGpu.index) : '0';
}

function tryParseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function stringifyJson(value) {
  return JSON.stringify(value, null, 2);
}

function fileUrl(path) {
  return `/api/files/${encodeURIComponent(path)}`;
}

function mediaUrl(path) {
  return `/api/img/${encodeURIComponent(path)}`;
}

function extensionOf(path) {
  const lower = String(path || '').toLowerCase();
  const index = lower.lastIndexOf('.');
  return index >= 0 ? lower.slice(index) : '';
}

function formatBytes(bytes) {
  if (!bytes) {
    return '0 B';
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = units[0];
  for (let index = 0; index < units.length; index += 1) {
    unit = units[index];
    if (value < 1024 || index === units.length - 1) {
      break;
    }
    value /= 1024;
  }
  return `${value.toFixed(value > 10 ? 1 : 2)} ${unit}`;
}

function formatDate(value) {
  if (!value) {
    return 'Unknown';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString();
}

function formatNumber(value) {
  const numeric = Number(value || 0);
  return Number.isFinite(numeric) ? numeric.toFixed(numeric >= 10 ? 0 : 1) : '0';
}

function titleForRoute() {
  switch (state.route?.section) {
    case 'dashboard':
      return 'Dashboard';
    case 'jobs':
      return state.route.mode === 'editor' ? 'Job Editor' : 'Jobs';
    case 'datasets':
      return 'Datasets';
    case 'settings':
      return 'Settings';
    default:
      return 'AI Toolkit Web';
  }
}

function subtitleForRoute() {
  switch (state.route?.section) {
    case 'dashboard':
      return 'Loading queues and telemetry.';
    case 'jobs':
      return 'Loading job metadata.';
    case 'datasets':
      return 'Loading dataset folders.';
    case 'settings':
      return 'Loading persisted settings.';
    default:
      return 'Loading.';
  }
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}









