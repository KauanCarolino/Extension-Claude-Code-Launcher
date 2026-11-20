// Aba de skills, desenhada dentro da view do launcher (mesma página das conversas: a troca é instantânea).
// Tudo é montado com textContent: nada vindo de SKILL.md vira HTML.
(function () {
	const LABELS = { all: 'Todas', project: 'Projeto', global: 'Global', claudeai: 'claude.ai' };
	const TITLES = { project: 'Projeto', global: 'Global', claudeai: 'claude.ai' };
	const BADGES = { project: 'projeto', global: 'global', claudeai: 'claude.ai' };
	let filter = 'all';
	let query = '';

	function el(tag, cls, text) {
		const n = document.createElement(tag);
		if (cls) { n.className = cls; }
		if (text !== undefined) { n.textContent = text; }
		return n;
	}

	function iconBtn(icon, title, onClick) {
		const b = el('button', 'sk-icon-btn');
		b.type = 'button'; b.title = title; b.setAttribute('aria-label', title);
		b.appendChild(el('span', 'codicon codicon-' + icon));
		b.addEventListener('click', onClick);
		return b;
	}

	/** Desenha as skills em `host`. `send(command, extra)` fala com a extensão. */
	window.renderSkills = function (host, state, send) {
		const wrap = el('div', 'sk-fade');
		const bar = el('div', 'sk-bar');
		const input = el('input'); input.type = 'search'; input.placeholder = 'Buscar skills…'; input.value = query;
		input.dataset.focusKey = 'sk-query';
		input.setAttribute('aria-label', 'Buscar skills');
		const list = el('div');
		input.addEventListener('input', () => { query = input.value; renderList(); });
		bar.append(input, iconBtn('refresh', 'Atualizar', () => send('skills.refresh')));
		const filters = el('div', 'sk-filters');
		for (const key of Object.keys(LABELS)) {
			const b = el('button', 'sk-filter', LABELS[key]); b.type = 'button';
			b.setAttribute('aria-pressed', String(filter === key));
			b.addEventListener('click', () => {
				filter = key;
				filters.querySelectorAll('.sk-filter').forEach((f) => f.setAttribute('aria-pressed', String(f === b)));
				renderList();
			});
			filters.appendChild(b);
		}
		wrap.append(bar, filters, list);
		host.appendChild(wrap);
		renderList();

		function renderList() {
			list.textContent = '';
			if (!state) { list.appendChild(el('div', 'sk-empty', 'Carregando…')); return; }
			const q = query.trim().toLowerCase();
			const items = state.skills.filter((s) => (filter === 'all' || s.scope === filter) &&
				(!q || s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q)));
			list.appendChild(el('div', 'sk-count', items.length + (items.length === 1 ? ' skill' : ' skills')));
			if (!items.length) {
				list.appendChild(el('div', 'sk-empty', state.skills.length ? 'Nenhuma skill encontrada.' : 'Nenhuma skill instalada.'));
			}
			for (const scope of ['project', 'global', 'claudeai']) {
				const group = items.filter((s) => s.scope === scope);
				const canCreate = scope !== 'claudeai' && (scope === 'global' || state.hasProject) && (filter === 'all' || filter === scope);
				if (!group.length && !(canCreate && filter === scope)) { continue; }
				const head = el('div', 'sk-group', TITLES[scope]);
				if (canCreate) {
					const add = el('button', 'sk-new', '+ Nova'); add.type = 'button';
					add.addEventListener('click', () => send('skills.create', { key: scope }));
					head.appendChild(add);
				}
				list.appendChild(head);
				group.forEach((s) => list.appendChild(row(s)));
			}
		}

		function row(s) {
			const r = el('div', 'sk-skill' + (s.state === 'disabled' ? ' disabled' : ''));
			const head = el('div', 'sk-head');
			const name = el('button', 'sk-name', s.name); name.type = 'button'; name.title = 'Abrir SKILL.md';
			name.disabled = s.state === 'broken';
			name.addEventListener('click', () => send('skills.open', { id: s.id }));
			head.appendChild(name);
			if (s.state === 'disabled') { head.appendChild(el('span', 'sk-badge off', 'desativada')); }
			if (s.state === 'broken') { head.appendChild(el('span', 'sk-badge broken', 'sem SKILL.md')); }
			head.appendChild(el('span', 'sk-badge ' + s.scope, BADGES[s.scope]));
			r.appendChild(head);
			if (s.description) { r.appendChild(el('p', 'sk-desc', s.description)); }
			const actions = el('div', 'sk-actions');
			actions.appendChild(iconBtn('folder-opened', 'Mostrar pasta', () => send('skills.reveal', { id: s.id })));
			if (s.scope !== 'claudeai') {
				if (s.state !== 'broken') {
					const off = s.state === 'disabled';
					actions.appendChild(iconBtn(off ? 'check' : 'circle-slash', off ? 'Ativar' : 'Desativar', () => send('skills.toggle', { id: s.id })));
				}
				actions.appendChild(iconBtn('trash', 'Excluir', () => send('skills.delete', { id: s.id })));
			}
			r.appendChild(actions);
			return r;
		}
	};
})();
