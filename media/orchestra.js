// Aba do orquestrador, desenhada dentro da view do launcher. A página só envia o pedido e os cliques:
// quem planeja, edita, commita, testa e abre o PR é a CLI `orquestra`, num processo da extensão.
// Tudo é montado com textContent: nada vindo de um job (pedido, plano, saída do teste) vira HTML.
(function () {
	const { t, plural } = window.launcherL10n;
	const MAX_REQUEST = 8000;
	const STATES = {
		planning: t('planejando'),
		running: t('executando'),
		blocked_quota: t('pausado: cota'),
		blocked_test: t('teste falhou'),
		needs_human: t('precisa de você'),
		passed: t('teste passou'),
		pr_open: t('PR aberto'),
	};
	// O que a pessoa digitou sobrevive aos redesenhos (o log chega linha a linha).
	let draft = '';
	let provider = '';
	let wantPr = false;
	const expanded = new Set();
	let lastFirstId = null;

	function el(tag, cls, text) {
		const n = document.createElement(tag);
		if (cls) { n.className = cls; }
		if (text !== undefined && text !== null) { n.textContent = text; }
		return n;
	}

	function icon(name) {
		const n = el('span', 'codicon codicon-' + name);
		n.setAttribute('aria-hidden', 'true');
		return n;
	}

	function btn(cls, iconName, label, onClick, disabled) {
		const b = el('button', cls);
		b.type = 'button';
		if (iconName) { b.append(icon(iconName)); }
		if (label) { b.append(el('span', null, label)); }
		b.disabled = !!disabled;
		b.addEventListener('click', (event) => { event.stopPropagation(); onClick(); });
		return b;
	}

	function iconBtn(iconName, title, onClick, disabled) {
		const b = btn('sk-icon-btn', iconName, null, onClick, disabled);
		b.title = title;
		b.setAttribute('aria-label', title);
		return b;
	}

	function duration(ms) {
		const s = Math.max(0, Math.round(ms / 1000));
		if (s < 60) { return s + 's'; }
		const m = Math.floor(s / 60);
		if (m < 60) { return m + 'm' + String(s % 60).padStart(2, '0') + 's'; }
		return Math.floor(m / 60) + 'h' + String(m % 60).padStart(2, '0') + 'm';
	}

	// O tempo da ação em andamento anda sozinho, sem esperar uma linha nova de log.
	setInterval(() => {
		document.querySelectorAll('.oq-elapsed').forEach((node) => {
			const started = Number(/** @type {HTMLElement} */ (node).dataset.started);
			if (started) { node.textContent = duration(Date.now() - started); }
		});
	}, 1000);

	/** Desenha a aba em `host`. `send(command, extra)` fala com a extensão. */
	window.renderOrchestra = function (host, state, send) {
		const wrap = el('div', 'oq');
		host.append(wrap);
		if (!state) { wrap.append(el('div', 'sk-empty', t('Carregando…'))); return; }
		if (!state.hasFolder) {
			wrap.append(emptyState('folder', t('Abra uma pasta'), t('O orquestrador trabalha num repositório git aberto no editor.')));
			return;
		}
		if (!state.cli.found) {
			const box = emptyState('rocket', t('CLI orquestra não encontrada'),
				t('Compile o orquestrador (cd orchestrator && npm run build), instale-o no PATH com npm link, ou indique o caminho do cli.js na configuração.'));
			box.append(btn('btn-secondary', 'gear', t('Abrir configuração'), () => send('orchestra.settings')));
			wrap.append(box);
			return;
		}
		const busy = !!state.running;
		if (state.folders.length > 1) { wrap.append(folderPicker(state, send, busy)); }
		wrap.append(providerBar(state, send));
		if (!state.hasProject) {
			const hint = el('div', 'oq-hint');
			hint.append(icon('info'), el('span', null, t('Sem .orquestra/project.json: o teste usado é npm test, na branch base main.')));
			hint.append(btn('btn-ghost btn-sm', null, t('Criar'), () => send('orchestra.createProject')));
			wrap.append(hint);
		}
		wrap.append(requestForm(state, send, busy));
		if (state.running) { wrap.append(runningBox(state.running, send)); }
		if (state.lastError && !state.running) {
			const err = el('div', 'oq-error');
			err.append(icon('error'), el('span', null, state.lastError));
			wrap.append(err);
		}
		wrap.append(jobList(state, send, busy));
	};

	function emptyState(iconName, title, text) {
		const box = el('div', 'empty-state');
		box.append(icon(iconName), el('p', 'empty-title', title), el('p', null, text));
		return box;
	}

	function folderPicker(state, send, busy) {
		const row = el('label', 'oq-field');
		row.append(el('span', 'oq-label', t('Pasta')));
		const select = el('select', 'oq-select');
		state.folders.forEach((name, index) => {
			const option = el('option', null, name);
			option.value = String(index);
			option.selected = index === state.folderIndex;
			select.append(option);
		});
		select.disabled = busy;
		select.addEventListener('change', () => send('orchestra.folder', { key: select.value }));
		row.append(select);
		return row;
	}

	function providerBar(state, send) {
		const bar = el('div', 'oq-providers');
		const items = state.providers ? [...state.providers.providers, { id: 'gh', ...state.providers.gh }] : [];
		if (!state.providers) {
			bar.append(el('span', 'muted', state.checkingProviders ? t('Conferindo claude, codex e gh…') : t('Modelos ainda não conferidos.')));
		}
		for (const p of items) {
			const chip = el('span', 'oq-chip' + (p.ok ? ' ok' : ' off'));
			chip.append(el('span', 'oq-dot'), el('span', null, p.id));
			chip.title = p.ok ? (p.id === 'gh' ? t('Pronto para abrir PRs') : t('Pronto')) : (p.reason || t('Indisponível'));
			bar.append(chip);
		}
		const refresh = iconBtn(state.checkingProviders ? 'loading' : 'refresh', t('Conferir de novo'), () => send('orchestra.refresh', { key: 'providers' }), state.checkingProviders);
		if (state.checkingProviders) { refresh.querySelector('.codicon')?.classList.add('codicon-modifier-spin'); }
		bar.append(refresh);
		return bar;
	}

	function requestForm(state, send, busy) {
		const form = el('div', 'oq-form');
		const area = /** @type {HTMLTextAreaElement} */ (el('textarea', 'oq-request'));
		area.placeholder = t('O que você quer mudar? Ex.: corrigir a soma em math.js para o teste passar');
		area.value = draft;
		area.maxLength = MAX_REQUEST;
		area.rows = 4;
		area.dataset.focusKey = 'oq-request';
		area.setAttribute('aria-label', t('Pedido para o orquestrador'));
		const submit = () => {
			if (busy || !draft.trim()) { return; }
			send('orchestra.plan', { text: draft, key: provider || undefined });
			draft = '';
			area.value = '';
		};
		area.addEventListener('input', () => { draft = area.value; plan.disabled = busy || !draft.trim(); });
		area.addEventListener('keydown', (event) => {
			if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); submit(); }
		});
		form.append(area);

		const options = el('div', 'oq-options');
		const select = /** @type {HTMLSelectElement} */ (el('select', 'oq-select'));
		select.setAttribute('aria-label', t('Modelo do planner'));
		const def = state.providers && state.providers.defaultProvider;
		for (const [value, label] of [['', def ? t('Padrão ({0})', def) : t('Modelo padrão')], ['claude', 'Claude'], ['codex', 'Codex']]) {
			const option = el('option', null, label);
			option.value = value;
			option.selected = value === provider;
			select.append(option);
		}
		select.addEventListener('change', () => { provider = select.value; });
		const prLabel = el('label', 'oq-check');
		const pr = /** @type {HTMLInputElement} */ (el('input'));
		pr.type = 'checkbox';
		pr.checked = wantPr;
		pr.addEventListener('change', () => { wantPr = pr.checked; });
		prLabel.append(pr, el('span', null, t('Abrir PR no final')));
		prLabel.title = t('Ao confirmar o plano: depois do teste verde, envia o branch e abre o PR com o gh.');
		options.append(select, prLabel);
		form.append(options);

		const actions = el('div', 'oq-form-actions');
		const plan = btn('btn-primary', 'sparkle', t('Planejar'), submit, busy || !draft.trim());
		plan.title = 'Ctrl+Enter';
		actions.append(plan, el('span', 'oq-note', t('Nada é editado antes de você confirmar o plano.')));
		form.append(actions);
		return form;
	}

	function runningBox(running, send) {
		const box = el('div', 'oq-running');
		const head = el('div', 'oq-running-head');
		const spin = icon('loading');
		spin.classList.add('codicon-modifier-spin');
		const elapsed = el('span', 'oq-elapsed muted', duration(Date.now() - running.startedAt));
		elapsed.dataset.started = String(running.startedAt);
		head.append(spin, el('span', 'oq-running-label', running.stopping ? t('Parando…') : running.label), elapsed);
		head.append(iconBtn('output', t('Ver log completo'), () => send('orchestra.log')));
		head.append(btn('btn-secondary btn-sm', 'debug-stop', t('Parar'), () => send('orchestra.stop'), running.stopping));
		box.append(head);
		const log = el('pre', 'oq-log');
		log.textContent = running.log.length ? running.log.join('\n') : t('Iniciando…');
		box.append(log);
		return box;
	}

	function jobList(state, send, busy) {
		const list = el('div', 'oq-jobs');
		if (!state.jobs.length) {
			list.append(el('div', 'sk-empty', t('Nenhuma tarefa ainda. Escreva um pedido acima.')));
			return list;
		}
		list.append(el('div', 'sk-group', plural(state.jobs.length, '{0} tarefa', '{0} tarefas')));
		// A tarefa mais nova abre sozinha quando aparece; as outras ficam como a pessoa deixou.
		const first = state.jobs[0].id;
		if (first !== lastFirstId) { expanded.add(first); lastFirstId = first; }
		for (const job of state.jobs) { list.append(jobCard(job, state, send, busy)); }
		return list;
	}

	function jobCard(job, state, send, busy) {
		const open = expanded.has(job.id);
		const mine = state.running && state.running.jobId === job.id;
		const awaiting = !job.planConfirmed && job.goal !== undefined;
		const card = el('div', 'oq-job' + (awaiting ? ' awaiting' : ''));
		const head = el('button', 'oq-job-head');
		head.type = 'button';
		head.setAttribute('aria-expanded', String(open));
		head.dataset.focusKey = 'oq-job:' + job.id;
		head.append(icon(open ? 'chevron-down' : 'chevron-right'));
		const stateLabel = awaiting ? t('plano pronto') : (STATES[job.state] || job.state);
		head.append(el('span', 'oq-state ' + (awaiting ? 'awaiting' : job.state), mine ? t('em andamento') : stateLabel));
		head.append(el('span', 'oq-job-title', job.request.split('\n')[0]));
		head.addEventListener('click', () => {
			if (expanded.has(job.id)) { expanded.delete(job.id); } else { expanded.add(job.id); }
			const host = /** @type {HTMLElement} */ (card.parentElement);
			card.replaceWith(jobCard(job, state, send, busy));
			const again = /** @type {HTMLElement | null} */ (host.querySelector('[data-focus-key="oq-job:' + job.id + '"]'));
			if (again) { again.focus(); }
		});
		card.append(head);
		if (job.reason && !mine) { card.append(el('p', 'oq-reason', job.reason)); }
		if (open) { card.append(jobBody(job)); }
		card.append(jobActions(job, send, busy));
		return card;
	}

	function jobBody(job) {
		const body = el('div', 'oq-job-body');
		if (job.request.includes('\n')) { body.append(el('p', 'oq-request-full', job.request)); }
		if (job.goal) { body.append(meta(t('Objetivo'), job.goal)); }
		if (job.steps.length) {
			const steps = el('ol', 'oq-steps');
			for (const s of job.steps) {
				const li = el('li', 'oq-step ' + s.status);
				li.append(icon(s.status === 'done' ? 'pass-filled' : s.status === 'running' ? 'circle-large-filled' : 'circle-large-outline'));
				const text = el('div', 'oq-step-text');
				text.append(el('span', 'oq-step-title', s.id + '. ' + s.title));
				const details = [s.files.join(', '), s.provider, s.commit, s.risk && t('risco {0}', s.risk), t('confiança {0}', s.confidence.toFixed(2))].filter(Boolean).join(' · ');
				text.append(el('span', 'oq-step-meta', details));
				li.append(text);
				steps.append(li);
			}
			body.append(steps);
		}
		if (job.planConfirmed) { body.append(meta(t('Branch'), job.branch)); }
		const models = Object.entries(job.timing.modelMs).map(([id, ms]) => id + ' ' + duration(ms)).join(', ');
		const end = job.timing.endedAt ? Date.parse(job.timing.endedAt) : Date.now();
		const quota = job.timing.quotaWaitMs + (job.timing.quotaSince ? Math.max(0, Date.now() - Date.parse(job.timing.quotaSince)) : 0);
		body.append(meta(t('Tempo'), [t('total {0}', duration(end - Date.parse(job.createdAt))), models && t('modelo {0}', models),
			job.timing.testMs && t('teste {0}', duration(job.timing.testMs)), quota && t('espera de cota {0}', duration(quota))].filter(Boolean).join(' · ')));
		if (job.repairCycles) { body.append(meta(t('Reparos'), String(job.repairCycles))); }
		if (job.lastTest) {
			const r = job.lastTest;
			body.append(meta(t('Último teste'), (r.passed ? t('passou') : t('falhou')) + ' — ' + r.command + ' (' + (r.timedOut ? t('tempo esgotado') : t('código {0}', String(r.exitCode))) + ', ' + duration(r.durationMs) + ')'));
		}
		if (job.prUrl) { body.append(meta('PR', job.prUrl)); } else if (job.prError) { body.append(meta('PR', t('não aberto — {0}', job.prError))); }
		return body;
	}

	function meta(label, value) {
		const row = el('div', 'oq-meta');
		row.append(el('span', 'oq-meta-label', label), el('span', 'oq-meta-value', value));
		return row;
	}

	function jobActions(job, send, busy) {
		const row = el('div', 'oq-job-actions');
		const id = job.id;
		for (const action of job.actions) {
			if (action === 'confirm') {
				const b = btn('btn-primary btn-sm', 'play', wantPr ? t('Confirmar e executar (com PR)') : t('Confirmar e executar'),
					() => send('orchestra.confirm', { id, key: wantPr ? 'pr' : undefined }), busy);
				b.title = t('Cria o branch, executa cada passo, commita e roda o teste do projeto.');
				row.append(b);
			} else if (action === 'drop') {
				row.append(btn('btn-ghost btn-sm', 'trash', t('Descartar plano'), () => send('orchestra.drop', { id }), busy));
			} else if (action === 'resume') {
				row.append(btn('btn-secondary btn-sm', 'debug-continue', t('Retomar'), () => send('orchestra.resume', { id }), busy));
			} else if (action === 'discard') {
				row.append(btn('btn-ghost btn-sm', 'discard', t('Retomar descartando sobras'), () => send('orchestra.discard', { id }), busy));
			} else if (action === 'pr') {
				row.append(btn('btn-secondary btn-sm', 'git-pull-request-create', t('Abrir PR'), () => send('orchestra.pr', { id }), busy));
			} else if (action === 'openPr') {
				row.append(btn('btn-secondary btn-sm', 'link-external', t('Ver PR'), () => send('orchestra.openPr', { id })));
			}
		}
		row.append(iconBtn('list-flat', t('Detalhes no canal Orquestra'), () => send('orchestra.details', { id })));
		return row;
	}
})();
