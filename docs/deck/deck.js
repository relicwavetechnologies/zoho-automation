/* Divo deck — shared top nav, injected into every page.
   Set <main data-page="..."> to highlight the active link. */
(function () {
  const LINKS = [
    { href: 'index.html',          label: 'Overview',     page: 'overview' },
    { href: 'day-with-divo.html',  label: 'A day with Divo', page: 'day', dot: 'blue' },
    { href: 'desktop.html',        label: 'The Desktop',  page: 'desktop' },
    { href: 'integrations.html',   label: 'Integrations', page: 'integrations' },
    { href: 'architecture.html',   label: 'Architecture', page: 'architecture' },
    { href: 'hermes-db.html',      label: 'DB Plan',      page: 'db', dot: 'green' },
    { href: 'roadmap.html',        label: 'Roadmap',      page: 'roadmap' },
  ];

  const active = (document.querySelector('main[data-page]') || {}).dataset?.page || '';

  const mark = `<span class="mark"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5h7a6 7 0 0 1 0 14H4Z"/></svg></span>`;

  const links = LINKS.map(l => {
    const isActive = l.page === active ? ' active' : '';
    const dot = l.dot ? `<span class="nd ${l.dot}"></span>` : '';
    return `<a href="${l.href}" class="${isActive.trim()}">${dot}${l.label}</a>`;
  }).join('');

  const nav = document.createElement('nav');
  nav.className = 'topnav';
  nav.innerHTML = `<div class="nav-inner">
    <a class="nav-brand" href="index.html">${mark}<span>Divo</span><span class="tag">product deck</span></a>
    <div class="nav-links">${links}</div>
  </div>`;

  document.body.insertBefore(nav, document.body.firstChild);
})();
