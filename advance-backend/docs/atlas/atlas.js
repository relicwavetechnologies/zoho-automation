/* ============================================================
   Divo Atlas — shared shell renderer.
   Single nav manifest → consistent sidebar + topbar on every page.
   To add a page: append to NAV below and create the .html file.
   ============================================================ */

const NAV = [
  {
    group: 'Product',
    items: [
      { id: 'overview',     label: 'Overview',          href: 'index.html',        status: 'shipped',  icon: 'home' },
      { id: 'architecture', label: 'Architecture',       href: 'architecture.html', status: 'shipped',  icon: 'layers' },
      { id: 'roadmap',      label: 'Roadmap & Status',   href: 'roadmap.html',      status: 'progress', icon: 'map' },
    ],
  },
  {
    group: 'Desktop experience',
    items: [
      { id: 'chat-ux',        label: 'Chat & Turns',       href: 'chat-ux.html',        status: 'shipped',  icon: 'message' },
      { id: 'streaming',      label: 'Activity Stream',    href: 'streaming.html',      status: 'shipped',  icon: 'activity' },
      { id: 'markdown',       label: 'Markdown Rendering', href: 'markdown.html',       status: 'shipped',  icon: 'text' },
      { id: 'context-memory', label: 'Context & Memory',   href: 'context-memory.html', status: 'progress', icon: 'database' },
    ],
  },
  {
    group: 'In flight',
    items: [
      { id: 'terminal', label: 'Terminal Execution', href: 'terminal.html', status: 'progress', icon: 'terminal' },
    ],
  },
];

const ICONS = {
  home:     '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/>',
  layers:   '<path d="m12 2 9 5-9 5-9-5 9-5Z"/><path d="m3 12 9 5 9-5"/><path d="m3 17 9 5 9-5"/>',
  map:      '<path d="M9 3 3 6v15l6-3 6 3 6-3V3l-6 3-6-3Z"/><path d="M9 3v15M15 6v15"/>',
  message:  '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z"/>',
  activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  text:     '<path d="M4 7V5h16v2M9 5v14M7 19h4"/>',
  terminal: '<path d="m4 17 6-6-6-6"/><path d="M12 19h8"/>',
  database: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/>',
  divo:     '<path d="M8 6v12M8 6c4 0 7 2 7 6s-3 6-7 6" stroke-width="2.2"/>',
};

function icon(name, cls) {
  return `<svg class="${cls || ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ''}</svg>`;
}

function currentPage() {
  const root = document.querySelector('[data-atlas-page]');
  return root ? root.getAttribute('data-atlas-page') : '';
}

function renderNav(active) {
  let html = `
    <a class="atlas-brand" href="index.html">
      <span class="mark">${icon('divo')}</span>
      <span>
        <div class="title">Divo Atlas</div>
        <div class="subtitle">the product, at a glance</div>
      </span>
    </a>
  `;
  for (const grp of NAV) {
    html += `<div class="nav-group-label">${grp.group}</div>`;
    for (const it of grp.items) {
      const isActive = it.id === active ? ' active' : '';
      html += `
        <a class="nav-item${isActive}" href="${it.href}">
          ${icon(it.icon, 'ni-icon')}
          <span>${it.label}</span>
          <span class="ni-dot ${it.status}" title="${it.status}"></span>
        </a>
      `;
    }
  }
  return html;
}

function renderTopbar(active) {
  let label = 'Overview';
  for (const grp of NAV) {
    const found = grp.items.find((i) => i.id === active);
    if (found) { label = found.label; break; }
  }
  return `
    <div class="crumb">Divo Atlas · <b>${label}</b></div>
    <div class="spacer"></div>
    <div class="atlas-legend">
      <span><span class="dot" style="background: var(--shipped)"></span> Shipped</span>
      <span><span class="dot" style="background: var(--progress)"></span> In progress</span>
      <span><span class="dot" style="background: var(--planned)"></span> Planned</span>
    </div>
  `;
}

function mountAtlas() {
  const active = currentPage();
  const nav = document.getElementById('atlas-nav');
  const topbar = document.getElementById('atlas-topbar');
  if (nav) nav.innerHTML = renderNav(active);
  if (topbar) topbar.innerHTML = renderTopbar(active);
}

document.addEventListener('DOMContentLoaded', mountAtlas);

/* Small helper exposed for pages that want a status pill inline */
window.Atlas = {
  pill(status) {
    const label = { shipped: 'Shipped', progress: 'In progress', planned: 'Planned' }[status] || status;
    return `<span class="pill ${status}"><span class="pd"></span>${label}</span>`;
  },
};
