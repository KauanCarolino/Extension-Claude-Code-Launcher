// View inicial do launcher: uma lista só de conversas. No topo as abertas em aba,
// depois as recentes agrupadas por dia. Monta tudo com textContent: nenhum título
// de conversa é interpretado como HTML.
(function () {
	const vscode = acquireVsCodeApi();
	const root = document.getElementById('root');
	const saved = readSaved();
	let filter = saved.filter || '';
	let lastState = null;
	let skillsState = null;
	// Abas além de Conversas: Skills tem desenho próprio (skills.js); as outras usam catalog.js.
	const TABS = [
		['chats', 'comment', 'Conversas'],
		['skills', 'sparkle', 'Skills'],
		['rules', 'law', 'Regras'],
		['agents', 'hubot', 'Agentes'],
		['mcp', 'plug', 'MCP'],
	];
	const catalogStates = {};
	let tab = TABS.some(([id]) => id === saved.tab) ? saved.tab : 'chats';

	window.addEventListener('message', (event) => {
		const data = event.data;
		if (!data) { return; }
		if (data.type === 'state') {
			lastState = data;
			if (tab === 'chats') { render(data); }
		} else if (data.type === 'skills') {
			skillsState = data;
			if (tab === 'skills') { renderPanelTab(); }
		} else if (data.type === 'catalog') {
			catalogStates[data.kind] = data;
			if (tab === data.kind) { renderPanelTab(); }
		} else if (data.type === 'tab') {
			// Troca pedida pela paleta de comandos.
			setTab(data.tab, true);
		}
	});
	vscode.postMessage({ command: 'ready' });
	// Alinha o painel de Mudanças (visível só na aba de conversas) com a aba restaurada.
	send('showPanel', { key: tab });
	if (tab !== 'chats') { send(tab + '.refresh'); }

	// Tempos relativos andam sozinhos, sem esperar um novo estado.
	setInterval(() => {
		if (lastState && tab === 'chats') {
			render(lastState);
		}
	}, 60 * 1000);

	// Setas para cima e para baixo andam entre as linhas.
	root.addEventListener('keydown', (event) => {
		if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') {
			return;
		}
		const current = document.activeElement;
		if (!current || !current.classList.contains('row-main')) {
			return;
		}
		const rows = [...root.querySelectorAll('.row-main')];
		const index = rows.indexOf(current);
		if (event.key === 'ArrowUp' && index === 0) {
			const search = root.querySelector('.search input');
			if (search) {
				event.preventDefault();
				search.focus();
			}
			return;
		}
		const next = rows[index + (event.key === 'ArrowDown' ? 1 : -1)];
		if (next) {
			event.preventDefault();
			next.focus();
		}
	});

	function readSaved() {
		try {
			return vscode.getState() || {};
		} catch {
			return {};
		}
	}

	function save() {
		vscode.setState({ filter, tab });
	}

	// ---- Helpers ---------------------------------------------------------------------

	function el(tag, className, text) {
		const node = document.createElement(tag);
		if (className) {
			node.className = className;
		}
		if (text !== undefined && text !== null) {
			node.textContent = text;
		}
		return node;
	}

	function icon(name) {
		const node = el('span', 'codicon codicon-' + name);
		node.setAttribute('aria-hidden', 'true');
		return node;
	}

	function send(command, extra) {
		vscode.postMessage(Object.assign({ command }, extra || {}));
	}

	/** Botão que manda `command`. `focusKey` deixa o foco voltar para ele depois de redesenhar. */
	function button(options) {
		const node = el('button', options.className);
		node.type = 'button';
		if (options.icon) {
			node.append(icon(options.icon));
		}
		if (options.label) {
			node.append(el('span', null, options.label));
		}
		if (options.title) {
			node.title = options.title;
		}
		if (options.ariaLabel) {
			node.setAttribute('aria-label', options.ariaLabel);
		}
		if (options.focusKey) {
			node.dataset.focusKey = options.focusKey;
		}
		node.addEventListener('click', (event) => {
			event.stopPropagation();
			send(options.command, options.extra);
		});
		return node;
	}

	// ---- Render ----------------------------------------------------------------------

	/** `fromHost`: a extensão já trocou o contexto (paleta); só falta a página acompanhar. */
	function setTab(next, fromHost) {
		if (tab === next || !TABS.some(([id]) => id === next)) { return; }
		tab = next;
		save();
		if (!fromHost) { send('showPanel', { key: next }); }
		if (next !== 'chats') {
			renderPanelTab();
			send(next + '.refresh');
		} else if (lastState) {
			render(lastState);
		}
	}

	function renderPanelTab() {
		const focus = captureFocus();
		root.replaceChildren(renderTabs());
		if (tab === 'skills') {
			window.renderSkills(root, skillsState, send);
		} else {
			window.renderCatalog(root, tab, catalogStates[tab] || null, send);
		}
		restoreFocus(focus);
	}

	function render(state) {
		const scroll = window.scrollY;
		const focus = captureFocus();

		root.replaceChildren();
		root.append(renderTabs());
		// Parte das conversas não pôde ser lida (transcript inacessível, por exemplo).
		if (state.coverageMessage) {
			root.append(renderHint('warning', state.coverageMessage, 'notice'));
		}
		if (!state.installed) {
			root.append(renderNotInstalled());
		} else {
			root.append(renderNew());
			renderConversations(state);
		}

		window.scrollTo(0, scroll);
		restoreFocus(focus);
	}

	function captureFocus() {
		const active = document.activeElement;
		if (!active || !active.dataset || !active.dataset.focusKey) {
			return null;
		}
		return { key: active.dataset.focusKey, start: active.selectionStart, end: active.selectionEnd };
	}

	function restoreFocus(focus) {
		if (!focus) {
			return;
		}
		const target = [...root.querySelectorAll('[data-focus-key]')].find((node) => node.dataset.focusKey === focus.key);
		if (!target) {
			return;
		}
		target.focus({ preventScroll: true });
		if (typeof focus.start === 'number' && typeof target.setSelectionRange === 'function') {
			target.setSelectionRange(focus.start, focus.end);
		}
	}

	// Barra de abas: a ativa mostra o nome, as outras só o ícone.
	function renderTabs() {
		const bar = el('div', 'tabbar');
		bar.setAttribute('role', 'tablist');
		for (const [target, name, label] of TABS) {
			const active = tab === target;
			const item = el('button', 'tabbar-tab' + (active ? ' active' : ''));
			item.type = 'button';
			item.setAttribute('role', 'tab');
			item.setAttribute('aria-selected', String(active));
			item.title = label;
			item.setAttribute('aria-label', label);
			item.append(icon(name));
			if (active) { item.append(el('span', null, label)); }
			item.addEventListener('click', () => setTab(target));
			bar.append(item);
		}
		return bar;
	}

	function renderNotInstalled() {
		const box = el('div', 'empty-state');
		box.append(icon('sparkle'));
		box.append(el('p', 'empty-title', 'Falta a extensão oficial do Claude Code'));
		box.append(el('p', null, 'O chat vem dela. Depois de instalar, as conversas aparecem aqui.'));
		box.append(button({ className: 'btn-primary', icon: 'cloud-download', label: 'Instalar Claude Code', command: 'install', focusKey: 'install' }));
		return box;
	}

	// Parece o campo de mensagem de um chat: chama para começar, sem gritar.
	function renderNew() {
		const node = button({
			className: 'new-chat',
			icon: 'add',
			label: 'Nova conversa',
			command: 'newTab',
			title: 'Abre uma conversa nova numa aba do editor',
			focusKey: 'newTab',
		});
		node.append(el('span', 'new-chat-hint', 'em aba'));
		return node;
	}

	function renderConversations(state) {
		const tabs = state.openTabs || [];
		const openLabels = new Set(tabs.map((tab) => tab.label));
		// Uma conversa aberta já aparece no grupo "Abertas": não repete na lista de recentes.
		const recent = state.hasFolder ? state.sessions.filter((session) => !session.open && !openLabels.has(session.title)) : [];

		if (tabs.length + recent.length > 6 || filter) {
			root.append(renderSearch());
		}
		const query = normalize(filter);
		const match = (text) => !query || normalize(text).includes(query);
		const shownTabs = tabs.filter((tab) => match(tab.label));
		const shownRecent = recent.filter((session) => match(session.title));

		if (shownTabs.length > 0) {
			root.append(renderGroup('Abertas', shownTabs.map(renderTab)));
		}

		if (!state.hasFolder) {
			root.append(renderHint('folder-opened', 'Abra uma pasta de projeto para ver as conversas dela.'));
			return;
		}
		if (state.sessions.length === 0 && tabs.length === 0) {
			root.append(renderHint('comment-discussion', 'Nenhuma conversa neste projeto ainda. Comece uma nova acima.'));
			return;
		}
		if (query && shownTabs.length === 0 && shownRecent.length === 0) {
			root.append(el('p', 'hint muted', 'Nenhuma conversa com “' + filter + '”.'));
			return;
		}

		const groups = new Map();
		for (const session of shownRecent) {
			const label = groupLabel(session.updated);
			if (!groups.has(label)) {
				groups.set(label, []);
			}
			groups.get(label).push(renderSession(session));
		}
		for (const [label, rows] of groups) {
			root.append(renderGroup(label, rows));
		}
	}

	function renderGroup(title, rows) {
		const section = el('section', 'group');
		section.append(el('h2', 'group-title', title));
		const list = el('ul', 'list');
		list.setAttribute('aria-label', title);
		list.append(...rows);
		section.append(list);
		return section;
	}

	function renderHint(name, text, extraClass) {
		const box = el('div', 'hint-box' + (extraClass ? ' ' + extraClass : ''));
		box.append(icon(name), el('span', null, text));
		return box;
	}

	function renderTab(tab) {
		const item = el('li', 'row' + (tab.active ? ' active' : ''));
		const main = button({
			className: 'row-main',
			command: 'focusTab',
			extra: { key: tab.key },
			title: tab.active ? tab.label + '\nAba ativa' : tab.label + '\nIr para esta aba',
			focusKey: 'tab:' + tab.key,
		});
		main.append(el('span', 'live-dot' + (tab.active ? ' on' : '')));
		main.append(el('span', 'row-title', tab.label));
		if (tab.active) {
			main.setAttribute('aria-current', 'true');
		}
		item.append(main);
		item.append(button({
			className: 'icon-btn row-action',
			icon: 'close',
			command: 'closeTab',
			extra: { key: tab.key },
			title: 'Fechar esta aba',
			ariaLabel: 'Fechar ' + tab.label,
			focusKey: 'close:' + tab.key,
		}));
		return item;
	}

	function renderSession(session) {
		const item = el('li', 'row');
		const main = button({
			className: 'row-main',
			command: 'openSession',
			extra: { id: session.id },
			title: session.title + '\n' + new Date(session.updated).toLocaleString('pt-BR') + ' · clique para abrir numa aba',
			focusKey: 'session:' + session.id,
		});
		main.append(el('span', 'row-title', session.title));
		main.append(el('span', 'row-time', shortTime(session.updated)));
		item.append(main);
		return item;
	}

	function renderSearch() {
		const box = el('label', 'search');
		box.append(icon('search'));
		const input = el('input');
		input.type = 'search';
		input.placeholder = 'Buscar conversas';
		input.value = filter;
		input.setAttribute('aria-label', 'Buscar conversas');
		input.dataset.focusKey = 'filter';
		input.addEventListener('input', () => {
			filter = input.value;
			save();
			if (lastState) {
				render(lastState);
			}
		});
		input.addEventListener('keydown', (event) => {
			if (event.key === 'Escape' && input.value) {
				event.preventDefault();
				input.value = '';
				input.dispatchEvent(new Event('input'));
			} else if (event.key === 'ArrowDown') {
				const first = root.querySelector('.row-main');
				if (first) {
					event.preventDefault();
					first.focus();
				}
			}
		});
		box.append(input);
		return box;
	}

	function normalize(text) {
		return String(text || '')
			.normalize('NFD')
			.replace(/[̀-ͯ]/g, '')
			.toLowerCase()
			.trim();
	}

	function startOfDay(ms) {
		const date = new Date(ms);
		date.setHours(0, 0, 0, 0);
		return date.getTime();
	}

	function groupLabel(ms) {
		const days = Math.round((startOfDay(Date.now()) - startOfDay(ms)) / 86400000);
		if (days <= 0) {
			return 'Hoje';
		}
		if (days === 1) {
			return 'Ontem';
		}
		if (days < 7) {
			return 'Esta semana';
		}
		if (days < 30) {
			return 'Este mês';
		}
		return 'Mais antigas';
	}

	/** Tempo curto, para caber à direita da linha: "agora", "5 min", "3 h", "2 d", "07 nov". */
	function shortTime(ms) {
		const minutes = Math.max(0, Math.round((Date.now() - ms) / 60000));
		if (minutes < 1) {
			return 'agora';
		}
		if (minutes < 60) {
			return minutes + ' min';
		}
		const hours = Math.round(minutes / 60);
		if (hours < 24) {
			return hours + ' h';
		}
		const days = Math.round(hours / 24);
		if (days < 7) {
			return days + ' d';
		}
		return new Date(ms).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' }).replace('.', '');
	}
})();
