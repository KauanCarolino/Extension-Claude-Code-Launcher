// Lista de skills. Tudo é montado com textContent: nada vindo de SKILL.md vira HTML.
(function () {
	const vscode = acquireVsCodeApi();
	const root = document.getElementById('root');
	const LABELS = { all: 'Todas', project: 'Projeto', global: 'Global', claudeai: 'claude.ai' };
	const TITLES = { project: 'Projeto', global: 'Global', claudeai: 'claude.ai' };
	const saved = (vscode.getState && vscode.getState()) || {};
	let filter = saved.filter || 'all';
	let query = saved.query || '';
	let state = null;

	window.addEventListener('message', (e) => { if (e.data && e.data.type === 'state') { state = e.data; render(); } });
	vscode.postMessage({ command: 'ready' });

	function el(tag, cls, text) {
		const n = document.createElement(tag);
		if (cls) { n.className = cls; }
		if (text !== undefined) { n.textContent = text; }
		return n;
	}
	function iconBtn(icon, title, onClick) {
		const b = el('button', 'icon-btn');
		b.type = 'button'; b.title = title; b.setAttribute('aria-label', title);
		b.appendChild(el('span', 'codicon codicon-' + icon));
		b.addEventListener('click', onClick);
		return b;
	}
	const save = () => vscode.setState && vscode.setState({ filter, query });

	function render() {
		const focused = document.activeElement && document.activeElement.id === 'q';
		root.textContent = '';
		const bar = el('div', 'bar');
		const input = el('input'); input.id = 'q'; input.type = 'search'; input.placeholder = 'Buscar skills…'; input.value = query;
		input.setAttribute('aria-label', 'Buscar skills');
		input.addEventListener('input', () => { query = input.value; save(); renderList(); });
		bar.append(input, iconBtn('refresh', 'Atualizar', () => vscode.postMessage({ command: 'refresh' })));
		const tabs = el('div', 'tabs');
		for (const key of Object.keys(LABELS)) {
			const b = el('button', 'tab', LABELS[key]); b.type = 'button';
			b.setAttribute('aria-pressed', String(filter === key));
			b.addEventListener('click', () => { filter = key; save(); render(); });
			tabs.appendChild(b);
		}
		root.append(bar, tabs, el('div'));
		root.lastChild.id = 'list';
		renderList();
		if (focused) { input.focus(); input.setSelectionRange(query.length, query.length); }
	}

	function renderList() {
		const list = document.getElementById('list');
		list.textContent = '';
		const q = query.trim().toLowerCase();
		const items = state.skills.filter((s) => (filter === 'all' || s.scope === filter) &&
			(!q || s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q)));
		list.appendChild(el('div', 'count', items.length + (items.length === 1 ? ' skill' : ' skills')));
		if (!items.length) {
			list.appendChild(el('div', 'empty', state.skills.length ? 'Nenhuma skill encontrada.' : 'Nenhuma skill instalada.'));
		}
		for (const scope of ['project', 'global', 'claudeai']) {
			const group = items.filter((s) => s.scope === scope);
			const canCreate = scope !== 'claudeai' && (scope === 'global' || state.hasProject) && (filter === 'all' || filter === scope);
			if (!group.length && !(canCreate && filter === scope)) { continue; }
			const head = el('div', 'group muted', TITLES[scope]);
			if (canCreate) {
				const add = el('button', 'new', '+ Nova'); add.type = 'button';
				add.addEventListener('click', () => vscode.postMessage({ command: 'create', scope }));
				head.appendChild(add);
			}
			list.appendChild(head);
			group.forEach((s) => list.appendChild(row(s)));
		}
	}

	function row(s) {
		const r = el('div', 'skill' + (s.state === 'disabled' ? ' disabled' : ''));
		const head = el('div', 'skill-head');
		const name = el('button', 'skill-name', s.name); name.type = 'button'; name.title = 'Abrir SKILL.md';
		name.disabled = s.state === 'broken';
		name.addEventListener('click', () => vscode.postMessage({ command: 'open', id: s.id }));
		head.appendChild(name);
		if (s.state === 'disabled') { head.appendChild(el('span', 'badge off', 'desativada')); }
		if (s.state === 'broken') { head.appendChild(el('span', 'badge broken', 'sem SKILL.md')); }
		head.appendChild(el('span', 'badge ' + s.scope, s.scope === 'claudeai' ? 'claude.ai' : s.scope === 'project' ? 'projeto' : 'global'));
		r.appendChild(head);
		if (s.description) { r.appendChild(el('p', 'skill-desc', s.description)); }
		const actions = el('div', 'actions');
		actions.appendChild(iconBtn('folder-opened', 'Mostrar pasta', () => vscode.postMessage({ command: 'reveal', id: s.id })));
		if (s.scope !== 'claudeai') {
			if (s.state !== 'broken') {
				actions.appendChild(iconBtn(s.state === 'disabled' ? 'check' : 'circle-slash', s.state === 'disabled' ? 'Ativar' : 'Desativar',
					() => vscode.postMessage({ command: 'toggle', id: s.id })));
			}
			actions.appendChild(iconBtn('trash', 'Excluir', () => vscode.postMessage({ command: 'delete', id: s.id })));
		}
		r.appendChild(actions);
		return r;
	}
})();
