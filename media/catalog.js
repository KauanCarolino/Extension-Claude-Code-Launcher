// Abas de regras, agentes e MCP, desenhadas dentro da view do launcher, no mesmo formato da aba de skills.
// Tudo é montado com textContent: nada vindo dos arquivos vira HTML.
(function () {
	const { t, plural } = window.launcherL10n;
	const KINDS = {
		rules: {
			count: (n) => plural(n, '{0} regra', '{0} regras'), search: t('Buscar regras…'), all: t('Todas'), add: t('+ Nova'),
			disabled: t('desativada'), empty: t('Nenhum CLAUDE.md ou regra encontrado.'),
			scopes: { project: t('Projeto'), global: t('Global'), managed: t('Organização') },
			creatable: ['project', 'global'], open: t('Abrir arquivo'),
		},
		agents: {
			count: (n) => plural(n, '{0} agente', '{0} agentes'), search: t('Buscar agentes…'), all: t('Todos'), add: t('+ Novo'),
			disabled: t('desativado'), empty: t('Nenhum agente instalado.'),
			scopes: { project: t('Projeto'), global: t('Global') },
			creatable: ['project', 'global'], open: t('Abrir arquivo do agente'),
		},
		mcp: {
			count: (n) => plural(n, '{0} servidor', '{0} servidores'), search: t('Buscar servidores MCP…'), all: t('Todos'), add: t('+ Novo'),
			disabled: t('desativado'), empty: t('Nenhum servidor MCP configurado.'),
			scopes: { local: t('Local'), project: t('Projeto'), user: t('Usuário'), managed: t('Organização') },
			hints: {
				local: t('Só você, neste projeto (~/.claude.json). Gerencie pelo /mcp ou por claude mcp.'),
				project: t('Compartilhado pelo repositório (.mcp.json).'),
				user: t('Todos os seus projetos (~/.claude.json). Gerencie pelo /mcp ou por claude mcp.'),
				managed: t('Definido pela organização (managed-mcp.json).'),
			},
			creatable: ['project'], open: t('Abrir a configuração na entrada do servidor'),
		},
		permissions: {
			count: (n) => plural(n, '{0} regra de permissão', '{0} regras de permissão'), search: t('Buscar permissões…'), all: t('Todas'), add: t('+ Nova'),
			disabled: t('desativada'), empty: t('Nenhuma regra de permissão configurada.'),
			scopes: { local: t('Local'), project: t('Projeto'), user: t('Usuário'), managed: t('Organização') },
			hints: {
				local: t('.claude/settings.local.json: só você, neste projeto.'),
				project: t('.claude/settings.json: compartilhado pelo repositório.'),
				user: t('settings.json do usuário: todos os seus projetos.'),
				managed: t('managed-settings.json: definido pela organização; vale acima dos outros.'),
			},
			creatable: ['local', 'project', 'user'], open: t('Abrir no arquivo de configurações'),
		},
		hooks: {
			count: (n) => plural(n, '{0} hook', '{0} hooks'), search: t('Buscar hooks…'), all: t('Todos'), add: t('+ Novo'),
			disabled: t('desligado'), empty: t('Nenhum hook configurado.'),
			scopes: { local: t('Local'), project: t('Projeto'), user: t('Usuário'), managed: t('Organização') },
			hints: {
				local: t('.claude/settings.local.json: só você, neste projeto.'),
				project: t('.claude/settings.json: compartilhado pelo repositório.'),
				user: t('settings.json do usuário: todos os seus projetos.'),
				managed: t('managed-settings.json: definido pela organização; vale acima dos outros.'),
			},
			creatable: [], open: t('Abrir no arquivo de configurações'),
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
		if (item.state === 'disabled') { return el('span', 'sk-badge off', KINDS[kind].disabled); }
		if (item.state === 'pending') { return el('span', 'sk-badge off', t('pendente')); }
		if (item.state === 'broken') { return el('span', 'sk-badge broken', kind === 'mcp' ? t('com erro') : t('link quebrado')); }
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
		bar.append(input, iconBtn('refresh', t('Atualizar'), () => send(kind + '.refresh')));
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
			if (!state) { list.appendChild(el('div', 'sk-empty', t('Carregando…'))); return; }
			for (const problem of state.problems || []) {
				const box = el('div', 'hint-box notice');
				const icon = el('span', 'codicon codicon-warning'); icon.setAttribute('aria-hidden', 'true');
				box.append(icon, el('span', null, problem));
				list.appendChild(box);
			}
			for (const note of state.notes || []) { list.appendChild(el('p', 'sk-note', note)); }
			if (state.managedPolicy) {
				list.appendChild(el('p', 'sk-note', t('Há um managed-mcp.json: a política da organização pode limitar os outros servidores.')));
			}
			const q = view.query.trim().toLowerCase();
			const items = state.items.filter((i) => (view.filter === 'all' || i.scope === view.filter) && matches(i, q));
			list.appendChild(el('div', 'sk-count', conf.count(items.length)));
			if (!items.length) {
				list.appendChild(el('div', 'sk-empty', state.items.length ? t('Nada encontrado.') : conf.empty));
			}
			for (const scope of Object.keys(conf.scopes)) {
				const group = items.filter((i) => i.scope === scope);
				const canCreate = creatable(scope) && (view.filter === 'all' || view.filter === scope);
				if (!group.length && !(canCreate && view.filter === scope)) { continue; }
				const head = el('div', 'sk-group', conf.scopes[scope]);
				if (canCreate) {
					const add = el('button', 'sk-new', conf.add); add.type = 'button';
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
				const s = el('span', 'sk-badge off', t('sobreposto'));
				s.title = kind === 'agents' ? t('Um agente do projeto com o mesmo nome tem prioridade.') : (item.note || '');
				head.appendChild(s);
			}
			if (item.folder) {
				const f = el('span', 'sk-badge', item.folder);
				f.title = t('Pasta do workspace');
				head.appendChild(f);
			}
			for (const tag of Array.isArray(item.tags) ? item.tags : []) {
				if (tag && tag.text) { head.appendChild(el('span', 'sk-badge' + (tag.tone ? ' ' + tag.tone : ''), tag.text)); }
			}
			if (item.model) { head.appendChild(el('span', 'sk-badge', item.model)); }
			if (item.transport) { head.appendChild(el('span', 'sk-badge', item.transport)); }
			r.appendChild(head);
			if (item.description) { r.appendChild(el('p', 'sk-desc', item.description)); }
			if (item.paths && item.paths.length) {
				const meta = el('p', 'sk-meta', t('Aplica-se a: {0}', item.paths.join(', ')));
				meta.title = item.paths.join('\n');
				r.appendChild(meta);
			}
			if (item.target) { r.appendChild(el('p', 'sk-meta', item.target)); }
			if ((kind === 'mcp' && item.state !== 'active' || kind === 'permissions' || kind === 'hooks') && item.note) { r.appendChild(el('p', 'sk-desc', item.note)); }
			const actions = el('div', 'sk-actions');
			actions.appendChild(iconBtn('folder-opened', t('Mostrar no sistema'), () => send(kind + '.reveal', { id: item.id })));
			if (item.canToggle) {
				const on = item.state === 'active';
				const label = kind === 'mcp' ? (on ? t('Recusar neste projeto') : t('Aprovar neste projeto')) : (on ? t('Desativar') : t('Ativar'));
				actions.appendChild(iconBtn(on ? 'circle-slash' : 'check', label, () => send(kind + '.toggle', { id: item.id })));
			}
			if (item.canDelete) {
				actions.appendChild(iconBtn('trash', kind === 'mcp' ? t('Remover do .mcp.json') : kind === 'permissions' ? t('Remover regra') : t('Excluir'), () => send(kind + '.delete', { id: item.id })));
			}
			r.appendChild(actions);
			return r;
		}
	};
})();
