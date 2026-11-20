// Painel "Mudanças do Claude". Monta tudo com textContent: nenhum texto vindo
// dos arquivos ou do Claude é interpretado como HTML.
(function () {
	const vscode = acquireVsCodeApi();
	const root = document.getElementById('root');

	/** Trechos com mais linhas que isso começam recolhidos. */
	const COLLAPSE_AT = 60;
	/** Quantas linhas um trecho recolhido mostra. */
	const COLLAPSED_LINES = 30;

	const saved = readSaved();
	const openCards = new Set(saved.openCards || []);
	const openCaptureHealth = new Set(Array.isArray(saved.openCaptureHealth) ? saved.openCaptureHealth.filter(Number.isSafeInteger) : []);
	const expandedHunks = new Set();
	let filesOpen = saved.filesOpen !== false;
	let legendOpen = Boolean(saved.legendOpen);
	let layout = saved.layout === 'split' ? 'split' : 'unified';
	let firstRender = !saved.openCards;
	let lastState = null;
	/** Outra janela é a dona da revisão (ou o estado não abriu): nada que mude a revisão funciona. */
	let readOnly = false;
	const MUTATIONS = new Set(['enable', 'disable', 'clear', 'purge', 'clearAllReviewData',
		'acceptAll', 'rejectAll', 'acceptFile', 'rejectFile', 'rejectRequest', 'undoReject']);

	window.addEventListener('message', (event) => {
		if (event.data && event.data.type === 'state') {
			lastState = event.data;
			render(event.data);
		}
	});
	vscode.postMessage({ command: 'ready' });
	setInterval(updateTimes, 60 * 1000);

	function readSaved() {
		try {
			return vscode.getState() || {};
		} catch {
			return {};
		}
	}

	function save() {
		vscode.setState({ openCards: [...openCards].slice(-100), openCaptureHealth: [...openCaptureHealth].slice(-100), filesOpen, legendOpen, layout });
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

	/**
	 * Botão que manda `command` (ou roda `onClick`). Fica dentro de <summary> às vezes:
	 * preventDefault evita que o clique abra ou feche o bloco.
	 */
	function button(options) {
		const node = el('button', options.className || 'btn-secondary');
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
		if (options.pressed !== undefined) {
			node.setAttribute('aria-pressed', String(options.pressed));
		}
		const recoveryPurge = options.recoveryPurge === true && options.command === 'clearAllReviewData';
		if (options.disabled || (readOnly && MUTATIONS.has(options.command) && !recoveryPurge)) {
			node.disabled = true;
		}
		node.addEventListener('click', (event) => {
			event.preventDefault();
			event.stopPropagation();
			if (options.onClick) {
				options.onClick();
			} else {
				send(options.command, options.extra);
			}
		});
		return node;
	}

	function rerender() {
		if (lastState) {
			render(lastState);
		}
	}

	// ---- Render ----------------------------------------------------------------------

	function render(state) {
		if (!Array.isArray(state.entries)) {
			return;
		}
		readOnly = Boolean(state.readOnlyReason) || state.readOnly === true;
		const scroll = window.scrollY;
		const focus = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.focusKey : null;

		document.body.classList.toggle('wide', Boolean(state.wide));
		document.body.classList.toggle('split', Boolean(state.wide) && layout === 'split');
		root.replaceChildren();
		// Na barra lateral, o estado do registro e as ações ficam no título da view.
		if (state.wide) {
			root.append(renderToolbar(state));
		}
		renderNotices(state);

		if (!state.hasFolder) {
			root.append(emptyState('folder-opened', 'Nenhuma pasta aberta', 'Abra uma pasta de projeto para registrar as mudanças do Claude.'));
		} else {
			renderContent(state);
		}

		window.scrollTo(0, scroll);
		if (focus) {
			const target = [...root.querySelectorAll('[data-focus-key]')].find((node) => node.dataset.focusKey === focus);
			if (target) {
				target.focus({ preventScroll: true });
			}
		}
	}

	/** Avisos da extensão: revisão só para leitura, cobertura parcial e captura. */
	function renderNotices(state) {
		if (state.readOnlyReason) {
			const recover = state.readOnlyAction === 'clearAllReviewData' ? button({
				className: 'btn-secondary btn-sm', icon: 'clear-all', label: 'Concluir limpeza…', command: 'clearAllReviewData',
				focusKey: 'recover-purge', recoveryPurge: true,
			}) : state.wide ? null : button({
				className: 'btn-secondary btn-sm',
				icon: 'unlock',
				label: 'Recuperar acesso…',
				command: 'recoverWriter',
				focusKey: 'recover',
			});
			root.append(banner('lock', 'Revisão só para leitura: ' + state.readOnlyReason, 'warning', recover));
		}
		for (const message of [state.coverageMessage, state.captureMessage]) {
			if (message) {
				root.append(banner('warning', message, 'warning'));
			}
		}
		if (Array.isArray(state.captureHealth)) {
			for (const health of state.captureHealth) { root.append(renderCaptureHealth(health)); }
		}
	}

	function renderCaptureHealth(health) {
		const box = el('details', 'legend capture-health');
		box.open = openCaptureHealth.has(health.workspace);
		box.addEventListener('toggle', () => {
			if (box.open) { openCaptureHealth.add(health.workspace); } else { openCaptureHealth.delete(health.workspace); }
			save();
		});
		const summary = el('summary');
		summary.dataset.focusKey = 'capture-health:' + health.workspace;
		summary.append(icon('pulse'), el('span', null, 'Diagnóstico de captura — pasta ' + health.workspace));
		box.append(summary);
		box.append(el('p', null, health.configurationLabel));
		box.append(el('p', null, health.capabilityLabel + (health.version ? ' Versão: ' + health.version + '.' : '')));
		box.append(el('p', null, health.evidenceLabel));
		const event = (label, value) => {
			box.append(el('p', null, value ? label + ': ' + value.at + ' · ' + value.label : label + ': sem evidência conhecida.'));
			if (value) { box.append(el('p', null, value.guidance)); box.append(el('p', null, value.content)); }
		};
		event('Última tentativa observada conhecida', health.observation);
		event('Última captura concluída conhecida', health.completion);
		box.append(el('p', null, health.coverageLabel));
		return box;
	}

	function banner(name, text, kind, action) {
		const box = el('div', 'banner ' + (kind || ''));
		box.append(icon(name));
		const body = el('div', 'banner-body');
		body.append(el('p', null, text));
		if (action) {
			body.append(action);
		}
		box.append(body);
		return box;
	}

	function reviewPartsLabel(item) {
		const valid = value => Number.isSafeInteger(value) && value >= 0;
		if (!['pending', 'blocked', 'complete'].includes(item.phase)) { return ''; }
		const parts = [];
		if (valid(item.acceptedParts) && item.acceptedParts) { parts.push(item.acceptedParts + (item.acceptedParts === 1 ? ' aceite' : ' aceites')); }
		if (valid(item.rejectedParts) && item.rejectedParts) { parts.push(item.rejectedParts + (item.rejectedParts === 1 ? ' recusa' : ' recusas')); }
		if (item.phase !== 'complete') {
			parts.push(valid(item.pendingParts) ? item.pendingParts + (item.pendingParts === 1 ? ' trecho pendente' : ' trechos pendentes') : 'Quantidade de trechos pendentes indisponível');
		}
		return parts.join(' · ');
	}

	function operationDescription(operation) {
		if (!operation || !['complete', 'partial', 'blocked', 'failed', 'recovered'].includes(operation.outcome)
			|| !['unchanged', 'buffer', 'persisted', 'unknown'].includes(operation.content)
			|| !['persisted', 'notPersisted', 'failed'].includes(operation.decision)) { return ''; }
		const actions = {
			retrySave: 'Salve o arquivo ou repita a ação no painel para conferir a intenção existente.',
			reconcile: 'Atualize o painel para conferir o registro pendente e repita a ação se a revisão continuar disponível.',
			compare: 'Confira o arquivo e a comparação antes de decidir novamente.',
			recoverWriter: 'Aguarde a operação ativa ou use os comandos de liberar e recuperar a revisão.',
			retry: 'Confira a condição informada antes de tentar novamente.',
			reviewAgain: 'Confira o resultado recuperado antes de repetir a nova ação.',
		};
		let message;
		if (operation.outcome === 'recovered') { message = 'Operação anterior recuperada; a nova ação não foi executada.'; }
		else if (operation.outcome === 'complete' && operation.decision === 'persisted') { message = 'Última decisão concluída e registrada.'; }
		else if (operation.decision === 'persisted') { message = operation.content === 'persisted' ? 'Conteúdo salvo e decisão canônica registrada; há um impedimento adicional.' : 'Decisão canônica registrada; o efeito atual no conteúdo precisa ser conferido.'; }
		else if (operation.lastKnownStage && operation.content === 'unknown') { message = 'Há uma operação interrompida; o conteúdo atual precisa ser conferido.'; }
		else if (operation.content === 'buffer') { message = 'Conteúdo aplicado no editor; salvamento não confirmado e decisão pendente.'; }
		else if (operation.content === 'persisted' && operation.decision !== 'persisted') { message = 'Conteúdo salvo; registro da decisão pendente.'; }
		else if (operation.content === 'unknown') { message = 'Efeito no conteúdo desconhecido; nenhuma conclusão anunciada.'; }
		else { message = 'Operação não concluída; conteúdo inalterado.'; }
		if (operation.cancellation === 'beforeEffect' && operation.content === 'unchanged') { message = 'Operação cancelada antes de alterar o conteúdo.'; }
		else if (operation.cancellation === 'afterEffect') { message = 'Operação cancelada após a aplicação. ' + message; }
		const guidance = operation.reason === 'purgeNeedsRecovery'
			? 'Use Apagar todos os dados locais de revisão para concluir a limpeza; não remova o marcador manualmente.'
			: operation.reason === 'legacyProjectionPending' && operation.decision === 'persisted'
			? 'Use Atualizar mudanças para recuperar a projeção de compatibilidade; a decisão canônica já foi concluída.' : actions[operation.nextAction];
		return [message, guidance].filter(Boolean).join(' ');
	}

	function renderReviewState(item) {
		const parts = reviewPartsLabel(item), operation = operationDescription(item.lastOperation);
		const blocked = item.phase === 'blocked' || typeof item.blockedReason === 'string' && Boolean(item.blockedReason);
		if (!parts && !operation && !blocked) { return null; }
		const box = el('div', 'review-state');
		if (parts) { box.append(el('p', 'muted', parts)); }
		if (blocked) {
			const reason = typeof item.blockedReason === 'string' ? item.blockedReason.slice(0, 800) : 'Confira o contexto antes de decidir.';
			const message = el('p'); message.append(icon('lock'), el('span', null, ' Revisão bloqueada: ' + reason)); box.append(message);
		}
		if (operation) { box.append(el('p', 'operation-result', operation)); }
		return box;
	}

	function renderContent(state) {
		if (!state.enabled) {
			root.append(renderIntro());
		}
		if (state.files && state.files.length > 0) {
			root.append(renderFiles(state));
		} else if (state.entries.length > 0 && !state.coverageMessage && !readOnly) {
			const done = el('p', 'all-reviewed');
			done.append(icon('pass'), el('span', null, 'Nada para revisar'));
			done.title = 'Todas as mudanças do Claude já foram aceitas ou recusadas';
			root.append(done);
		}

		if (state.entries.length === 0) {
			if (state.enabled) {
				root.append(emptyState('inbox', 'Nenhuma mudança ainda', 'Peça ao Claude para editar um arquivo e ela aparece aqui, com o motivo e o diff.'));
			}
			return;
		}

		if (firstRender) {
			openCards.add(state.entries[0].id);
			firstRender = false;
			save();
		}

		// Diff precisa de largura: na barra lateral o histórico é uma lista compacta,
		// e cada linha leva ao código ou à tela maior.
		const compact = !state.wide;
		const renderItem = compact ? renderCompactEntry : renderEntry;
		const history = el('section', 'history' + (compact ? ' compact' : ''));
		history.setAttribute('aria-label', 'Histórico de mudanças');
		let lastDay = '';
		let group = null;
		for (const entry of state.entries) {
			const day = dayLabel(entry.time);
			if (day !== lastDay) {
				history.append(el('h2', 'day', day));
				lastDay = day;
				group = null;
			}
			if (!entry.requestId) {
				group = null;
				history.append(renderItem(entry));
				continue;
			}
			if (!group || group.id !== entry.requestId) {
				group = { id: entry.requestId, box: renderRequest(entry, state.entries) };
				history.append(group.box);
			}
			group.box.append(renderItem(entry));
		}
		root.append(history);
		if (compact) {
			root.append(button({
				className: 'btn-ghost btn-sm see-diffs',
				icon: 'screen-full',
				label: 'Ver os diffs na tela maior',
				command: 'openPanel',
				focusKey: 'openPanel',
			}));
		} else {
			root.append(renderLegend());
		}
	}

	/** Uma linha por edição: status, arquivo, +/− e quando. Clique abre no código. */
	function renderCompactEntry(entry) {
		const row = el('div', 'entry-row' + (entry.status ? ' ' + entry.status : ' pending'));
		const tooltip = [entry.action + ' ' + (entry.dir ? entry.dir + '/' : '') + entry.file, entry.summary];
		if (entry.reason) {
			tooltip.push('', 'Claude: ' + entry.reason);
		}
		if (entry.blockedReason) {
			tooltip.push('', entry.blockedReason);
		}
		tooltip.push('', entry.canCompare ? 'Clique para ver no código' : 'Clique para abrir o arquivo');
		const main = button({
			className: 'entry-main',
			command: entry.canCompare ? 'showInCode' : 'openFile',
			extra: { id: entry.id },
			title: tooltip.join('\n'),
			focusKey: 'entry:' + entry.id,
		});
		const marker = el('span', 'entry-status');
		if (entry.status === 'accepted') {
			marker.append(icon('check'));
			marker.title = 'Aceita';
		} else if (entry.status === 'rejected') {
			marker.append(icon('discard'));
			marker.title = 'Recusada';
		} else if (entry.status === 'mixed') {
			marker.append(icon('pass'));
			marker.title = 'Revisada: partes aceitas e recusadas';
		} else {
			marker.append(el('span', 'pending-dot'));
			marker.title = 'Para revisar';
		}
		main.append(marker);
		main.append(el('span', 'entry-file', entry.file));
		if (entry.action === 'Criou') {
			main.append(el('span', 'entry-tag', 'novo'));
		}
		main.append(renderStats(entry, false));
		const time = el('span', 'entry-time', shortTime(entry.time));
		time.dataset.time = entry.time;
		time.dataset.short = '1';
		main.append(time);
		row.append(main);
		if (entry.canCompare) {
			row.append(button({
				className: 'icon-btn entry-action',
				icon: 'diff',
				command: 'compare',
				extra: { id: entry.id },
				title: 'Abrir o diff desta edição',
				ariaLabel: 'Diff de ' + entry.file,
				focusKey: 'compare:' + entry.id,
			}));
		} else {
			row.append(el('span', 'entry-action-spacer'));
		}
		const reviewState = renderReviewState(entry);
		if (reviewState) { row.classList.add('has-review-state'); row.append(reviewState); }
		return row;
	}

	function emptyState(name, title, text) {
		const box = el('div', 'empty-state');
		box.append(icon(name));
		box.append(el('p', 'empty-title', title));
		box.append(el('p', null, text));
		return box;
	}

	// Na barra lateral, as ações ficam no título da view (Atualizar, Tela maior, menu ...).
	// Na tela maior não há título de view, então elas vêm para cá.
	function renderToolbar(state) {
		const bar = el('header', 'toolbar');
		const configured = Array.isArray(state.captureHealth)
			? state.captureHealth.some((health) => health.configuration === 'configured') : state.enabled;
		const lead = el('div', 'toolbar-lead');
		if (state.wide) {
			lead.append(el('h1', 'page-title', 'Mudanças do Claude'));
		}
		if (state.hasFolder) {
			const status = el('span', 'status ' + (configured ? 'on' : 'off'));
			status.append(el('span', 'status-dot'));
			status.append(el('span', null, configured ? 'Registro configurado' : 'Registro desligado ou indisponível'));
			status.title = 'Configuração e execução são evidências distintas. Consulte o diagnóstico de captura.';
			lead.append(status);
		}
		bar.append(lead);

		if (!state.wide) {
			return bar;
		}
		const actions = el('div', 'toolbar-actions');
		if (state.canUndo) {
			actions.append(button({
				className: 'btn-secondary',
				icon: 'discard',
				label: 'Desfazer recusa',
				command: 'undoReject',
				title: 'Traz de volta as mudanças do Claude que você acabou de recusar',
				focusKey: 'undo',
			}));
		}
		if (state.entries.length > 0) {
			actions.append(renderLayoutSwitch());
		}
		actions.append(button({ className: 'icon-btn', icon: 'refresh', command: 'refresh', title: 'Atualizar', ariaLabel: 'Atualizar', focusKey: 'refresh' }));
		if (state.entries.length > 0) {
			actions.append(button({ className: 'icon-btn', icon: 'trash', command: 'clear', title: 'Limpar histórico revisado (as pendências ficam)', ariaLabel: 'Limpar histórico revisado', focusKey: 'clear' }));
		}
		if (state.hasFolder) {
			actions.append(button({ className: 'icon-btn', icon: 'clear-all', command: 'clearAllReviewData', title: 'Limpeza completa: apaga todos os dados locais de revisão…', ariaLabel: 'Limpeza completa', focusKey: 'purge' }));
			if (readOnly) {
				actions.append(button({ className: 'icon-btn', icon: 'lock', command: 'recoverWriter', title: 'Recuperar acesso à revisão…', ariaLabel: 'Recuperar acesso à revisão', focusKey: 'recover' }));
			} else if (state.reviewWriter) {
				actions.append(button({ className: 'icon-btn', icon: 'unlock', command: 'releaseWriter', title: 'Liberar a revisão para outra janela', ariaLabel: 'Liberar a revisão para outra janela', focusKey: 'release' }));
			}
		}
		if (state.hasFolder && configured) {
			actions.append(button({ className: 'icon-btn', icon: 'debug-pause', command: 'disable', title: 'Desligar o registro', ariaLabel: 'Desligar o registro', focusKey: 'disable' }));
		}
		bar.append(actions);
		return bar;
	}

	function renderLayoutSwitch() {
		const group = el('div', 'segmented');
		group.setAttribute('role', 'group');
		group.setAttribute('aria-label', 'Formato do diff');
		const options = [
			['unified', 'list-flat', 'Unificado'],
			['split', 'split-horizontal', 'Lado a lado'],
		];
		for (const [value, iconName, label] of options) {
			group.append(button({
				className: 'segment' + (layout === value ? ' selected' : ''),
				icon: iconName,
				label,
				pressed: layout === value,
				focusKey: 'layout:' + value,
				onClick: () => {
					layout = value;
					save();
					rerender();
				},
			}));
		}
		return group;
	}

	function renderIntro() {
		const box = el('div', 'intro');
		const head = el('div', 'intro-head');
		head.append(icon('history'));
		head.append(el('span', 'intro-title', 'Registre o que o Claude muda'));
		box.append(head);
		box.append(el('p', null, 'Cada arquivo que o Claude editar fica guardado aqui: o que saiu, o que entrou e o motivo que ele deu. Você aceita ou recusa cada mudança.'));
		box.append(el('p', 'muted small', 'Isso adiciona um hook em .claude/settings.local.json deste projeto e vale para conversas iniciadas depois de ativar.'));
		box.append(el('p', 'muted small', 'Versões de arquivos e pedidos ficam salvos neste projeto. Confira as exclusões de privacidade nas configurações antes de ativar.'));
		box.append(button({ className: 'btn-primary', icon: 'record', label: 'Ativar registro', command: 'enable', focusKey: 'enable' }));
		return box;
	}

	// ---- Arquivos para revisar ---------------------------------------------------------

	function renderFiles(state) {
		const box = el('details', 'files');
		box.open = filesOpen;
		box.addEventListener('toggle', () => {
			filesOpen = box.open;
			save();
		});

		const head = el('summary', 'files-head');
		head.dataset.focusKey = 'files';
		const title = el('span', 'files-title');
		title.append(icon('chevron-right'));
		title.append(el('span', null, 'Para revisar'));
		title.append(el('span', 'count', String(state.files.length)));
		head.append(title);

		const headActions = el('span', 'files-actions');
		headActions.append(button({
			className: state.wide ? 'btn-ghost btn-sm accept' : 'icon-btn accept',
			icon: 'check-all',
			label: state.wide ? 'Aceitar todos' : null,
			ariaLabel: 'Aceitar todos',
			command: 'acceptAll',
			title: 'Mantém tudo como o Claude deixou e tira os arquivos desta lista',
			focusKey: 'acceptAll',
		}));
		headActions.append(button({
			className: state.wide ? 'btn-ghost btn-sm reject' : 'icon-btn reject',
			icon: 'discard',
			label: state.wide ? 'Recusar todos' : null,
			ariaLabel: 'Recusar todos',
			command: 'rejectAll',
			title: 'Volta cada arquivo para como era antes do Claude editar',
			focusKey: 'rejectAll',
		}));
		head.append(headActions);
		box.append(head);

		const list = el('ul', 'files-list');
		for (const file of state.files) {
			const row = el('li', 'file-row');
			const path = (file.dir ? file.dir + '/' : '') + file.file;
			const main = button({
				className: 'file-main',
				icon: fileIcon(file.file),
				command: file.deleted ? 'openFile' : 'showInCode',
				extra: { id: file.id },
				title: path + '\nClique para ver a mudança no código',
				focusKey: 'file:' + file.key,
			});
			main.append(el('span', 'file-name' + (file.deleted ? ' gone' : ''), file.file));
			if (file.dir) {
				main.append(el('span', 'file-dir', file.dir));
			}
			if (file.created) {
				main.append(el('span', 'chip add', 'novo'));
			}
			if (file.deleted) {
				main.append(el('span', 'chip del', 'apagado'));
			}
			main.append(renderStats(file, false));
			row.append(main);

			// Se o arquivo mudou desde que a lista foi montada, a extensão recusa a ação.
			const identity = { key: file.key };
			if (Number.isSafeInteger(file.revision) && file.revision >= 0) {
				identity.revision = file.revision;
			}
			const blocked = Boolean(file.blockedReason);
			if (blocked) {
				row.classList.add('blocked');
				main.title += '\n' + file.blockedReason;
			}
			const rowActions = el('span', 'file-actions');
			rowActions.append(button({
				className: 'icon-btn accept',
				icon: 'check',
				command: 'acceptFile',
				extra: identity,
				disabled: blocked && file.canAcceptCurrent !== true,
				title: blocked && file.canAcceptCurrent === true ? 'Aceitar explicitamente o estado atual, preservando as contribuições manuais' : blocked ? file.blockedReason : 'Aceitar as mudanças neste arquivo',
				ariaLabel: 'Aceitar ' + file.file,
				focusKey: 'accept:' + file.key,
			}));
			rowActions.append(button({
				className: 'icon-btn reject',
				icon: 'close',
				command: 'rejectFile',
				extra: identity,
				disabled: blocked,
				title: blocked ? file.blockedReason : 'Recusar: volta este arquivo para como era antes do Claude',
				ariaLabel: 'Recusar ' + file.file,
				focusKey: 'reject:' + file.key,
			}));
			row.append(rowActions);
			const reviewState = renderReviewState(file);
			if (reviewState) { row.classList.add('has-review-state'); row.append(reviewState); }
			list.append(row);
		}
		box.append(list);
		return box;
	}

	function fileIcon(name) {
		const lower = name.toLowerCase();
		const ext = lower.includes('.') ? lower.slice(lower.lastIndexOf('.') + 1) : '';
		if (ext === 'json' || ext === 'jsonc') {
			return 'json';
		}
		if (ext === 'md' || ext === 'mdx') {
			return 'markdown';
		}
		if (ext === 'ipynb') {
			return 'notebook';
		}
		if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico'].includes(ext)) {
			return 'file-media';
		}
		if (['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'css', 'scss', 'html', 'vue', 'go', 'rs', 'java', 'cs', 'rb', 'php', 'sh', 'c', 'cpp', 'h', 'kt', 'swift', 'sql', 'yml', 'yaml', 'toml', 'xml'].includes(ext)) {
			return 'file-code';
		}
		return 'file';
	}

	// ---- Histórico ---------------------------------------------------------------------

	// Agrupa as edições feitas para atender a mesma mensagem do usuário.
	function renderRequest(entry, entries) {
		const same = entries.filter((item) => item.requestId === entry.requestId);
		const files = new Set(same.map((item) => (item.dir ? item.dir + '/' : '') + item.file));
		const compact = !document.body.classList.contains('wide');
		const box = el('div', 'request');
		const head = el('div', 'request-head');
		const text = el('div', 'request-text');
		if (compact) {
			text.append(icon('comment'));
		} else {
			const label = el('span', 'request-label');
			label.append(icon('comment'), el('span', null, 'Seu pedido'));
			text.append(label);
		}
		const quote = el('p', 'request-quote', entry.request);
		quote.title = 'Seu pedido: ' + entry.request;
		text.append(quote);
		head.append(text);

		const meta = el('div', 'request-meta');
		// Só aparece ao passar o mouse ou focar: é uma ação rara, não precisa ocupar a tela.
		if (!readOnly && same.some((item) => item.status !== 'rejected')) {
			meta.append(button({
				className: compact ? 'icon-btn request-undo' : 'btn-ghost btn-sm request-undo',
				icon: 'discard',
				label: compact ? null : 'Desfazer pedido',
				command: 'rejectRequest',
				extra: { request: entry.requestId },
				title: 'Desfazer pedido: volta os arquivos para como eram antes dele',
				ariaLabel: 'Desfazer pedido',
				focusKey: 'request:' + entry.requestId,
			}));
		}
		if (!compact) {
			meta.append(el('span', 'muted', files.size === 1 ? '1 arquivo' : files.size + ' arquivos'));
		}
		head.append(meta);
		box.append(head);
		return box;
	}

	function renderEntry(entry) {
		const card = el('details', 'card' + (entry.status ? ' ' + entry.status : ''));
		card.open = openCards.has(entry.id);

		const head = el('summary', 'card-head');
		head.dataset.focusKey = 'card:' + entry.id;
		const title = el('div', 'card-title');
		title.append(icon('chevron-right'));
		title.append(el('span', 'chip ' + actionClass(entry.action), entry.action));
		const name = el('span', 'card-file', entry.file);
		name.title = (entry.dir ? entry.dir + '/' : '') + entry.file;
		title.append(name);
		if (entry.status === 'accepted') {
			const tag = el('span', 'status-tag accepted');
			tag.append(icon('check'), el('span', null, 'aceita'));
			title.append(tag);
		} else if (entry.status === 'rejected') {
			const tag = el('span', 'status-tag rejected');
			tag.append(icon('discard'), el('span', null, 'recusada'));
			title.append(tag);
		} else if (entry.status === 'mixed') {
			const tag = el('span', 'status-tag mixed');
			tag.append(icon('pass'), el('span', null, 'em partes'));
			tag.title = 'Revisada: partes aceitas e partes recusadas';
			title.append(tag);
		}
		if (entry.phase === 'blocked') {
			const tag = el('span', 'status-tag'); tag.append(icon('lock'), el('span', null, 'bloqueada'));
			tag.title = typeof entry.blockedReason === 'string' ? entry.blockedReason.slice(0, 800) : 'Revisão bloqueada'; title.append(tag);
		}
		head.append(title);
		const parts = reviewPartsLabel(entry);
		if (parts) { head.append(el('span', 'muted review-parts', parts)); }

		const meta = el('div', 'card-meta');
		meta.append(renderStats(entry, true));
		const time = el('span', 'time', relativeLabel(entry.time));
		time.dataset.time = entry.time;
		time.title = exactLabel(entry.time);
		meta.append(time);
		head.append(meta);
		card.append(head);

		// O corpo, com todos os trechos, só é montado quando o card abre.
		let built = false;
		const build = () => {
			if (!built) {
				built = true;
				card.append(renderBody(entry));
			}
		};
		if (card.open) {
			build();
		}
		card.addEventListener('toggle', () => {
			if (card.open) {
				build();
				openCards.add(entry.id);
			} else {
				openCards.delete(entry.id);
			}
			save();
		});
		return card;
	}

	function renderBody(entry) {
		const body = el('div', 'card-body');
		if (entry.dir) {
			const dir = el('div', 'card-dir');
			dir.append(icon('folder'), el('span', null, entry.dir + '/'));
			body.append(dir);
		}
		body.append(el('p', 'card-summary', entry.summary));

		if (entry.reason) {
			const reason = el('div', 'reason');
			const label = el('div', 'reason-label');
			label.append(icon('sparkle'), el('span', null, 'O que o Claude disse antes de editar'));
			reason.append(label);
			reason.append(el('div', 'reason-text', entry.reason));
			body.append(reason);
		}
		if (entry.note) {
			const note = el('div', 'banner warning');
			note.append(icon('warning'));
			const text = el('div', 'banner-body');
			text.append(el('p', null, entry.note));
			note.append(text);
			body.append(note);
		}
		const reviewState = renderReviewState(entry);
		if (reviewState) { body.append(reviewState); }

		entry.hunks.forEach((hunk, index) => body.append(renderHunk(entry, hunk, index)));

		const actions = el('div', 'card-actions');
		if (entry.canCompare) {
			actions.append(button({ className: 'btn-primary', icon: 'go-to-file', label: 'Ver no código', command: 'showInCode', extra: { id: entry.id }, focusKey: 'show:' + entry.id }));
			actions.append(button({ className: 'btn-secondary', icon: 'diff', label: 'Lado a lado', command: 'compare', extra: { id: entry.id }, title: 'Abre o diff do editor com o antes e o depois desta edição', focusKey: 'compare:' + entry.id }));
		} else {
			actions.append(button({ className: 'btn-secondary', icon: 'go-to-file', label: 'Abrir arquivo', command: 'openFile', extra: { id: entry.id }, focusKey: 'open:' + entry.id }));
		}
		body.append(actions);
		return body;
	}

	function renderStats(item, withModified) {
		const stats = el('span', 'stats');
		if (item.added) {
			stats.append(el('span', 'stat add', '+' + item.added));
		}
		if (item.removed) {
			stats.append(el('span', 'stat del', '−' + item.removed));
		}
		if (withModified && item.modified) {
			const mod = el('span', 'stat mod', '~' + item.modified);
			mod.title = item.modified === 1 ? '1 linha modificada' : item.modified + ' linhas modificadas';
			stats.append(mod);
		}
		return stats;
	}

	// ---- Trechos de diff ---------------------------------------------------------------

	function renderHunk(entry, hunk, index) {
		const total = entry.hunks.length;
		const key = entry.id + ':' + index;
		const box = el('div', 'hunk');
		const head = el('div', 'hunk-head');
		const label = total > 1 ? 'Trecho ' + (index + 1) + ' de ' + total : 'Trecho alterado';
		head.append(el('span', 'hunk-title', label));
		if (hunk.label) {
			head.append(el('span', 'hunk-label', hunk.label));
		}
		box.append(head);

		const split = document.body.classList.contains('split');
		const rows = split ? splitRows(hunk.lines) : hunk.lines;
		const collapsed = rows.length > COLLAPSE_AT && !expandedHunks.has(key);
		const visible = collapsed ? rows.slice(0, COLLAPSED_LINES) : rows;

		const code = el('div', split ? 'code split-code' : 'code');
		for (const row of visible) {
			code.append(split ? renderSplitRow(row) : renderLine(row));
		}
		box.append(code);

		if (collapsed) {
			const hidden = rows.length - COLLAPSED_LINES;
			box.append(button({
				className: 'btn-ghost btn-sm expand',
				icon: 'unfold',
				label: 'Mostrar mais ' + hidden + (hidden === 1 ? ' linha' : ' linhas'),
				focusKey: 'expand:' + key,
				onClick: () => {
					expandedHunks.add(key);
					box.replaceWith(renderHunk(entry, hunk, index));
				},
			}));
		}
		return box;
	}

	function renderLine(line) {
		const row = el('div', 'row ' + line.kind + (line.pair ? ' paired' : ''));
		const number = line.kind === 'del' ? line.oldNo : line.newNo;
		row.append(el('span', 'no', number === undefined ? '' : String(number)));
		row.append(el('span', 'sign', signOf(line.kind)));
		row.append(lineText(line));
		if (line.pair) {
			row.append(el('span', 'tag', line.pair));
		}
		return row;
	}

	/** Junta cada bloco de linhas removidas com o de linhas novas, lado a lado. */
	function splitRows(lines) {
		const rows = [];
		let index = 0;
		while (index < lines.length) {
			if (lines[index].kind === 'ctx') {
				rows.push([lines[index], lines[index]]);
				index += 1;
				continue;
			}
			const dels = [];
			const adds = [];
			while (index < lines.length && lines[index].kind !== 'ctx') {
				(lines[index].kind === 'del' ? dels : adds).push(lines[index]);
				index += 1;
			}
			for (let k = 0; k < Math.max(dels.length, adds.length); k += 1) {
				rows.push([dels[k] || null, adds[k] || null]);
			}
		}
		return rows;
	}

	function renderSplitRow(pair) {
		const row = el('div', 'split-row');
		row.append(splitCell(pair[0], 'oldNo'), splitCell(pair[1], 'newNo'));
		return row;
	}

	function splitCell(line, numberField) {
		if (!line) {
			const empty = el('div', 'row filler');
			empty.append(el('span', 'no'), el('span', 'sign'), el('span', 'text'));
			return empty;
		}
		const cell = el('div', 'row ' + line.kind + (line.pair ? ' paired' : ''));
		const number = line[numberField];
		cell.append(el('span', 'no', number === undefined ? '' : String(number)));
		cell.append(el('span', 'sign', signOf(line.kind)));
		cell.append(lineText(line));
		return cell;
	}

	function lineText(line) {
		const text = el('span', 'text');
		if (line.segments) {
			for (const segment of line.segments) {
				text.append(el('span', segment.changed ? 'word' : null, segment.text));
			}
		} else {
			text.textContent = line.text === '' ? ' ' : line.text;
		}
		return text;
	}

	function signOf(kind) {
		return kind === 'add' ? '+' : kind === 'del' ? '−' : ' ';
	}

	function renderLegend() {
		const details = el('details', 'legend');
		details.open = legendOpen;
		details.addEventListener('toggle', () => {
			legendOpen = details.open;
			save();
		});
		const summary = el('summary');
		summary.dataset.focusKey = 'legend';
		summary.append(icon('question'), el('span', null, 'Como ler as mudanças'));
		details.append(summary);
		const list = el('ul');
		const items = [
			['row add', '+', 'Linha nova: não existia antes.'],
			['row del', '−', 'Linha removida: existia e foi apagada.'],
			['row del paired', '−', 'Linha modificada, versão de antes. O destaque forte mostra as palavras que saíram.'],
			['row add paired', '+', 'Linha modificada, versão de depois. O destaque forte mostra as palavras que entraram.'],
			['row ctx', ' ', 'Linha sem mudança, mostrada só para dar contexto.'],
		];
		for (const [className, sign, text] of items) {
			const item = el('li');
			const sample = el('span', className + ' sample');
			sample.append(el('span', 'sign', sign));
			item.append(sample, el('span', null, text));
			list.append(item);
		}
		details.append(list);
		return details;
	}

	function actionClass(action) {
		if (action === 'Criou') {
			return 'add';
		}
		if (action === 'Reescreveu') {
			return 'del';
		}
		return 'mod';
	}

	// ---- Datas ---------------------------------------------------------------------------

	function updateTimes() {
		for (const node of root.querySelectorAll('[data-time]')) {
			node.textContent = node.dataset.short ? shortTime(node.dataset.time) : relativeLabel(node.dataset.time);
		}
	}

	/** Tempo curto, para caber no fim da linha: "agora", "5 min", "3 h" ou a hora. */
	function shortTime(iso) {
		const ms = new Date(iso).getTime();
		if (isNaN(ms)) {
			return '';
		}
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
		return new Date(ms).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
	}

	function relativeLabel(iso) {
		const ms = new Date(iso).getTime();
		if (isNaN(ms)) {
			return '';
		}
		const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000));
		if (seconds < 60) {
			return 'agora';
		}
		const minutes = Math.round(seconds / 60);
		if (minutes < 60) {
			return 'há ' + minutes + ' min';
		}
		const hours = Math.round(minutes / 60);
		if (hours < 24) {
			return 'há ' + hours + ' h';
		}
		return new Date(ms).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
	}

	function exactLabel(iso) {
		const date = new Date(iso);
		return isNaN(date.getTime()) ? '' : date.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'medium' });
	}

	function dayLabel(iso) {
		const date = new Date(iso);
		if (isNaN(date.getTime())) {
			return '';
		}
		const today = new Date();
		const yesterday = new Date();
		yesterday.setDate(today.getDate() - 1);
		if (date.toDateString() === today.toDateString()) {
			return 'Hoje';
		}
		if (date.toDateString() === yesterday.toDateString()) {
			return 'Ontem';
		}
		return date.toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' });
	}
})();
