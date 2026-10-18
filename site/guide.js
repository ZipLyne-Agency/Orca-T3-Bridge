const overview = document.getElementById('overview');
const guide = document.getElementById('guide');
const choices = [...document.querySelectorAll('[data-mode]')];
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
function displayMode(mode, scroll = false) {
  const full = mode === 'guide';
  overview.hidden = full;
  guide.hidden = !full;
  for (const choice of choices) {
    const active = choice.dataset.mode === mode;
    choice.classList.toggle('active', active);
    if (active) choice.setAttribute('aria-current', 'true');
    else choice.removeAttribute('aria-current');
  }
  if (scroll) (full ? guide : overview).scrollIntoView({ behavior: reducedMotion.matches ? 'instant' : 'smooth', block: 'start' });
}
for (const choice of choices) choice.addEventListener('click', event => {
  event.preventDefault();
  history.pushState(null, '', `#${choice.dataset.mode}`);
  displayMode(choice.dataset.mode, true);
});
function followHash() {
  const id = location.hash.slice(1);
  const target = document.getElementById(id);
  if (id === 'content') return;
  displayMode(target && (target === guide || guide.contains(target)) ? 'guide' : 'overview');
  if (target && id !== 'content') requestAnimationFrame(() => target.scrollIntoView({ block: 'start' }));
}
addEventListener('popstate', followHash);
addEventListener('hashchange', followHash);
followHash();
const sections = [...document.querySelectorAll('.guide-body section')];
const observer = new IntersectionObserver(entries => {
  for (const entry of entries) if (entry.isIntersecting) {
    for (const link of document.querySelectorAll('.toc nav a')) link.classList.toggle('current', link.hash === `#${entry.target.id}`);
  }
}, { rootMargin: '-15% 0px -60% 0px' });
sections.forEach(section => observer.observe(section));
