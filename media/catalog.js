// Abas de regras, agentes e MCP, desenhadas dentro da view do launcher, no mesmo formato da aba de skills.
// Tudo é montado com textContent: nada vindo dos arquivos vira HTML.
(function () {
	const KINDS = {
		rules: {
			one: 'regra', many: 'regras', search: 'Buscar regras…', all: 'Todas', fem: true,
			empty: 'Nenhum CLAUDE.md ou regra encontrado.',
			scopes: { project: 'Projeto', global: 'Global', managed: 'Organização' },
			creatable: ['project', 'global'], open: 'Abrir arquivo',
		},
		agents: {
			one: 'agente', many: 'agentes', search: 'Buscar agentes…', all: 'Todos',
			empty: 'Nenhum agente instalado.',
			scopes: { project: 'Projeto', global: 'Global' },
			creatable: ['project', 'global'], open: 'Abrir arquivo do agente',
		},
		mcp: {
			one: 'servidor', many: 'servidores', search: 'Buscar servidores MCP…', all: 'Todos',
			empty: 'Nenhum servidor MCP configurado.',
			scopes: { local: 'Local', project: 'Projeto', user: 'Usuário', managed: 'Organização' },
			hints: {
				local: 'Só você, neste projeto (~/.claude.json). Gerencie pelo /mcp ou por claude mcp.',
				project: 'Compartilhado pelo repositório (.mcp.json).',
				user: 'Todos os seus projetos (~/.claude.json). Gerencie pelo /mcp ou por claude mcp.',
				managed: 'Definido pela organização (managed-mcp.json).',
			},
			creatable: ['project'], open: 'Abrir a configuração na entrada do servidor',
		},
	};
	const ui = {};

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

	function stateBadge(kind, item) {
		const fem = KINDS[kind].fem;
		if (item.state === 'disabled') { return el('span', 'sk-badge off', fem ? 'desativada' : 'desativado'); }
		if (item.state === 'pending') { return el('span', 'sk-badge off', 'pendente'); }
		if (item.state === 'broken') { return el('span', 'sk-badge broken', kind === 'mcp' ? 'com erro' : 'link quebrado'); }
		return null;
	}

	/** Desenha a aba `kind` em `host`. `send(command, extra)` fala com a extensão. */
	window.renderCatalog = function (host, kind, state, send) {
		const conf = KINDS[kind];
		const view = ui[kind] || (ui[kind] = { filter: 'all', query: '' });
		const wrap = el('div', 'sk-fade');
		const bar = el('div', 'sk-bar');
		const input = el('input'); input.type = 'search'; input.placeholder = conf.search; input.value = view.query;
		input.dataset.focusKey = 'cat-query-' + kind;
		input.setAttribute('aria-label', conf.search.replace('…', ''));
		const filters = el('div', 'sk-filters');
		const list = el('div');
		input.addEventListener('input', () => { view.query = input.value; renderList(); });
		bar.append(input, iconBtn('refresh', 'Atualizar', () => send(kind + '.refresh')));
		wrap.append(bar, filters, list);
		host.appendChild(wrap);
		renderFilters();
		renderList();

		function creatable(scope) {
			return Boolean(state) && conf.creatable.includes(scope) && (scope !== 'project' || state.hasProject);
		}

		// Só aparecem os filtros com itens ou onde dá para criar: a barra cabe na lateral estreita.
		function renderFilters() {
			filters.textContent = '';
			const items = state ? state.items : [];
			const keys = ['all', ...Object.keys(conf.scopes).filter((s) => creatable(s) || items.some((i) => i.scope === s))];
			if (!keys.includes(view.filter)) { view.filter = 'all'; }
			for (const key of keys) {
				const b = el('button', 'sk-filter', key === 'all' ? conf.all : conf.scopes[key]); b.type = 'button';
				b.setAttribute('aria-pressed', String(view.filter === key));
				b.addEventListener('click', () => {
					view.filter = key;
					filters.querySelectorAll('.sk-filter').forEach((f) => f.setAttribute('aria-pressed', String(f === b)));
					renderList();
				});
				filters.appendChild(b);
			}
		}

		function matches(item, q) {
			return !q || [item.name, item.description, item.target, item.file].some((t) => typeof t === 'string' && t.toLowerCase().includes(q));
		}

		function renderList() {
			list.textContent = '';
			if (!state) { list.appendChild(el('div', 'sk-empty', 'Carregando…')); return; }
			for (const problem of state.problems || []) {
				const box = el('div', 'hint-box notice');
				const icon = el('span', 'codicon codicon-warning'); icon.setAttribute('aria-hidden', 'true');
				box.append(icon, el('span', null, problem));
				list.appendChild(box);
			}
			if (state.managedPolicy) {
				list.appendChild(el('p', 'sk-note', 'Há um managed-mcp.json: a política da organização pode limitar os outros servidores.'));
			}
			const q = view.query.trim().toLowerCase();
			const items = state.items.filter((i) => (view.filter === 'all' || i.scope === view.filter) && matches(i, q));
			list.appendChild(el('div', 'sk-count', items.length + ' ' + (items.length === 1 ? conf.one : conf.many)));
			if (!items.length) {
				list.appendChild(el('div', 'sk-empty', state.items.length ? 'Nada encontrado.' : conf.empty));
			}
			for (const scope of Object.keys(conf.scopes)) {
				const group = items.filter((i) => i.scope === scope);
				const canCreate = creatable(scope) && (view.filter === 'all' || view.filter === scope);
				if (!group.length && !(canCreate && view.filter === scope)) { continue; }
				const head = el('div', 'sk-group', conf.scopes[scope]);
				if (canCreate) {
					const add = el('button', 'sk-new', conf.fem ? '+ Nova' : '+ Novo'); add.type = 'button';
					add.addEventListener('click', () => send(kind + '.create', { key: scope }));
					head.appendChild(add);
				}
				list.appendChild(head);
				if (conf.hints && conf.hints[scope]) { list.appendChild(el('p', 'sk-note', conf.hints[scope])); }
				group.forEach((i) => list.appendChild(row(i)));
			}
		}

		function row(item) {
			const r = el('div', 'sk-skill' + (item.state === 'disabled' || item.shadowed ? ' disabled' : ''));
			if (item.note) { r.title = item.note; }
			const head = el('div', 'sk-head');
			const name = el('button', 'sk-name', item.name); name.type = 'button';
			name.title = conf.open + (item.file && item.file !== item.name ? ' (' + item.file + ')' : '');
			name.disabled = item.state === 'broken' && kind !== 'mcp';
			name.addEventListener('click', () => send(kind + '.open', { id: item.id }));
			head.appendChild(name);
			const badge = stateBadge(kind, item);
			if (badge) { head.appendChild(badge); }
			if (item.shadowed) {
				const s = el('span', 'sk-badge off', 'sobreposto');
				s.title = kind === 'agents' ? 'Um agente do projeto com o mesmo nome tem prioridade.' : (item.note || '');
				head.appendChild(s);
			}
			if (item.model) { head.appendChild(el('span', 'sk-badge', item.model)); }
			if (item.transport) { head.appendChild(el('span', 'sk-badge', item.transport)); }
			r.appendChild(head);
			if (item.description) { r.appendChild(el('p', 'sk-desc', item.description)); }
			if (item.paths && item.paths.length) {
				const meta = el('p', 'sk-meta', 'Aplica-se a: ' + item.paths.join(', '));
				meta.title = item.paths.join('\n');
				r.appendChild(meta);
			}
			if (item.target) { r.appendChild(el('p', 'sk-meta', item.target)); }
			if (kind === 'mcp' && item.note && item.state !== 'active') { r.appendChild(el('p', 'sk-desc', item.note)); }
			const actions = el('div', 'sk-actions');
			actions.appendChild(iconBtn('folder-opened', 'Mostrar no sistema', () => send(kind + '.reveal', { id: item.id })));
			if (item.canToggle) {
				const on = item.state === 'active';
				const label = kind === 'mcp' ? (on ? 'Recusar neste projeto' : 'Aprovar neste projeto') : (on ? 'Desativar' : 'Ativar');
				actions.appendChild(iconBtn(on ? 'circle-slash' : 'check', label, () => send(kind + '.toggle', { id: item.id })));
			}
			if (item.canDelete) {
				actions.appendChild(iconBtn('trash', kind === 'mcp' ? 'Remover do .mcp.json' : 'Excluir', () => send(kind + '.delete', { id: item.id })));
			}
			r.appendChild(actions);
			return r;
		}
	};
})();
