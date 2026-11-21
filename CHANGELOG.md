# Changelog

O projeto segue [Versionamento Semântico](https://semver.org/lang/pt-BR/) a partir da 1.0.0.

## 1.1.0 — 2026-11-21

### Adicionado

- Abas **Regras**, **Agentes** e **MCP** na view do launcher, no formato da aba **Skills**: busca, filtros por origem, criação e ações em cada linha.
  - **Regras:** `CLAUDE.md`, `.claude/CLAUDE.md`, `CLAUDE.local.md`, `.claude/rules/**/*.md` do projeto e os equivalentes globais, além do `CLAUDE.md` gerenciado pela organização (somente leitura). Mostra os globs de `paths`, ativa e desativa por `.md.disabled`, cria regras com `paths` opcional e exclui para a lixeira.
  - **Agentes:** `.claude/agents/` do projeto e global, inclusive em subpastas. Mostra `name`, descrição e `model`, marca o agente global encoberto por um do projeto de mesmo nome, e ativa, desativa, cria e exclui como as regras.
  - **MCP:** servidores locais, do projeto (`.mcp.json`), do usuário e da organização, com transporte, comando ou URL sem segredos aparentes, estado (ativo, pendente, recusado, desativado pelo `/mcp`, com erro) e prioridade entre escopos. Para servidores do projeto, aprova ou recusa no `.claude/settings.local.json`, cria e remove no `.mcp.json`. O `~/.claude.json` só é lido, nunca gravado.
- Comandos **Mostrar regras**, **Mostrar agentes** e **Mostrar servidores MCP**.

### Corrigido

- Os comandos **Mostrar skills** e **Mostrar conversas e mudanças**, pela paleta, só escondiam ou mostravam a view **Mudanças**: a view do launcher continuava na aba anterior. Agora ela também troca de aba.
- **Skills:** o nome da skill aparecia centralizado na linha e um nome longo não era cortado com reticências.

### Interno

- O frontmatter passou para `src/frontmatter.ts`, compartilhado por skills, regras e agentes; `parseFrontmatter` continua exportado por `skills.ts` com o mesmo comportamento.
- A troca de abas (contexto `claudeCodeLauncher.panel`) saiu de `skills-view.ts` para `catalog-view.ts`. A view **Mudanças** fica visível com o contexto ausente ou igual a `chats`.
- Contrato `multi-window` no macOS: o relatório passava, mas o runner mandava SIGTERM 500 ms depois, quando o VS Code ainda fechava sozinho (o driver executa `workbench.action.quit`), e o Electron abortava com SIGABRT. O runner agora espera até 10 s pela saída do próprio editor antes de encerrá-lo. Saídas por SIGABRT continuam reprovando. Teste em `host-runner.test.js` reproduz a falha com a espera antiga.
- 18 testes novos em `test/catalogs.test.js`, cobrindo leitura, escrita condicional, os formatos de `paths`, a ocultação de segredos e o controlador da view com o editor simulado.

## 1.0.0 — 2026-11-20

Primeira versão estável. Não há funcionalidade nova em relação à 0.13.1: esta versão fecha o que já existia, corrige os problemas encontrados na revisão e define o que passa a ser compatível dentro da série 1.x.

### Compromisso de compatibilidade (1.x)

Dentro da série 1.x, uma versão nova não remove nem muda o significado de:

- os IDs de comandos `claude-code-launcher.*` e os atalhos documentados;
- as configurações `claudeCodeLauncher.*`, seus valores aceitos e padrões;
- os formatos versionados em `.claude/launcher-changes/` (`review-state.v1.json`, `review-blobs/v1/`, `purge-state.v1.json`, `capture-diagnostics/v2/`, `log.jsonl`, `meta.json` e `status.json`). Uma versão 1.x lê os dados gravados por qualquer versão 1.x anterior. Quando um formato precisar mudar, a versão nova migra os dados e guarda backup em `review-migration-backups/`, e o CHANGELOG informa se o downgrade continua possível;
- a convenção `SKILL.md.disabled` usada para desativar skills.

Mudanças incompatíveis nesses pontos só entram numa versão 2.0.0. A aparência dos painéis, os textos das mensagens e os arquivos internos sem versão (`active/`, `pending/`, `completed/`, locks) não fazem parte do compromisso.

### Mudança de identificador: leia antes de atualizar

A extensão passou a se chamar **Launcher for Claude Code**, com o identificador `KauanDeveloper.launcher-for-claude-code`. O nome `claude-code-launcher` (e o nome de exibição "Claude Code Launcher") já pertence a outra extensão no Visual Studio Marketplace, sem relação com esta. O publisher também mudou, de `kauan` para `KauanDeveloper`. O editor trata a 1.0.0 como uma extensão **diferente** da 0.x:

- Desinstale a versão anterior antes de instalar a 1.0.0: `kauan.claude-code-launcher` (até a 0.13.0) ou `KauanDeveloper.claude-code-launcher` (pacote local da 0.13.1). Duas versões escrevendo no mesmo projeto não são suportadas.
- Os comandos, as configurações, o contêiner e a view mantêm os IDs `claude-code-launcher.*` e `claudeCodeLauncher.*`; só o nome exibido muda para **Launcher for Claude Code**, inclusive a categoria dos comandos na paleta.
- Os dados em `.claude/launcher-changes/`, os hooks e as configurações `claudeCodeLauncher.*` continuam valendo, porque não dependem do identificador. Um hook legado gravado no `globalStorage` do identificador antigo continua reconhecido como do launcher.
- Não passam para a 1.0.0, porque o editor os guarda por identificador: a pilha de **Desfazer a última recusa** e o registro das preferências de abertura definidas pela gestão de grupos. Antes de atualizar, conclua os desfazer pendentes e, se `claudeCodeLauncher.manageEditorGroups` estiver ligado, desligue-o na versão antiga, para ela restaurar suas preferências originais.

### Corrigido

- Os testes de host procuravam a extensão pelo identificador antigo e falhavam em todos os sistemas depois da troca de publisher. Agora leem o identificador do `package.json`.
- **Skills:** uma descrição com barra invertida gerava um `SKILL.md` com YAML inválido (por exemplo, `C:\temp` virava a sequência de escape `\t`). Barras invertidas, aspas e caracteres de controle agora são escapados ou substituídos.
- **Skills:** um `SKILL.md` salvo com BOM tinha o nome e a descrição ignorados.
- **Skills:** a pasta global ignorava `CLAUDE_CONFIG_DIR`, que a lista de conversas já respeitava. Com a variável definida, as skills globais passam a vir de `$CLAUDE_CONFIG_DIR/skills`.
- **Skills:** ativar ou desativar uma skill alterada fora do launcher mostrava um erro de sistema genérico. Agora explica o motivo. As skills do claude.ai também são recusadas na camada de disco, não só na interface.
- **Mudanças por conversa:** o painel podia esconder as mudanças da conversa em uso. Três casos foram reproduzidos com o código real:
  - A aba oficial mostra o título gerado antes de o transcript gravá-lo. Quando esse título curto coincidia com o de uma conversa antiga, o painel filtrava pela antiga e escondia a atual.
  - No chat da barra lateral, que não é aba, o foco ficava preso na última aba usada e as mudanças da lateral sumiam.
  - Títulos com mais de 25 caracteres, que a aba corta em 24 + "…", nunca eram reconhecidos, e o filtro ficava desligado sem aviso.

  Agora a conversa é comparada com todos os títulos que já teve, inclusive a primeira mensagem, levando em conta o corte da aba, e é reidentificada quando o transcript muda. Com o filtro ligado, só ficam ocultas as mudanças de conversas que outra aba aberta identificou. As pendentes sem dono continuam visíveis, com aviso, e sem nenhuma aba de chat o painel mostra tudo.
- **Mudanças por conversa:** com duas ou mais conversas de mesmo título, o painel escolhia a mais recente e escondia as mudanças das outras. Agora mostra as de todas e avisa no topo quantas conversas têm aquele título.
- **Conversas:** a marca de conversa aberta usava a mesma comparação exata de título e falhava em títulos cortados pela aba.
- O link do README para `docs/VERIFICACAO.md` apontava para um arquivo ignorado pelo Git, que não chegava ao repositório. O arquivo passa a ser versionado; o resto de `docs/` continua local.

### Adicionado

- Verificação em Linux registrada em `docs/VERIFICACAO.md`: teste de host no VS Code 1.147.0 e no Cursor 3.30.14, e contratos `multi-window`, `lifecycle` e `official` (Claude Code 2.1.329).
- Workflow de release (`.github/workflows/release.yml`): ao enviar uma tag `vX.Y.Z`, confere se a tag bate com o `package.json` e o CHANGELOG, repete as validações e o teste de host, gera e verifica o VSIX e o publica no Visual Studio Marketplace e no Open VSX (quando os segredos `VSCE_PAT` e `OVSX_PAT` existem) e numa release do GitHub.
- Manifesto com `homepage`, `bugs` e `galleryBanner` para a página do Marketplace.

### Interno

- Testes de skills ampliados de 1 para 15, cobrindo o controlador da view com o editor simulado: ids que não vieram da listagem são ignorados, skills do claude.ai não são alternadas nem excluídas, excluir exige confirmação e usa a lixeira, criar respeita o escopo e nunca sobrescreve.
- Os testes de host no Windows falhavam depois de aprovados: o runner encerra só o processo principal do editor, e os processos auxiliares do Electron mantinham o diretório temporário travado (`EBUSY`). A remoção agora tenta de novo com espera crescente e, se o diretório continuar travado, avisa qual pasta ficou sem alterar o resultado do teste.
- Teste do controlador real para o hook legado no `globalStorage` do identificador antigo; sem a correção, **Ativar registro** ficava bloqueado com `ambiguousHookOwnership`.
- Teste de ponta a ponta do filtro por conversa (`test/chat-scope.test.js`): `extension.js` e `ChangesController` reais, com abas e transcripts simulados conforme o comportamento da extensão oficial 2.1.329.
- A associação entre aba e conversa saiu de `extension.ts` para `matchChatSessions` em `logic.ts`, com testes próprios, e o aviso do painel ganhou teste de interface.

## 0.13.1 — 2026-11-20

### Alterado

- Novo ícone: balão de chat na cor terracota com o prompt `>_` e uma faísca, em versão colorida (marketplace) e monocromática (barra lateral).
- A categoria da extensão passou a incluir **AI**.
- O README ganhou um resumo e um passo a passo no início. Os detalhes de verificação foram para `docs/VERIFICACAO.md`.
- Constantes e utilitários independentes do controlador de mudanças foram movidos para `changes-support.ts`, sem alteração de comportamento.

## 0.13.0 — 2026-11-20

### Adicionado

- O painel **Mudanças** agora mostra só os arquivos da conversa em foco. Ao trocar de conversa, a lista acompanha. Um aviso no topo indica qual conversa está sendo mostrada, e **Ver todas** mostra também as de outras conversas. Sem conversa identificada (por exemplo, uma conversa nova ainda sem mensagens), o painel mostra tudo.

## 0.12.5 — 2026-11-20

As versões intermediárias 0.12.x, como a 0.12.1 do commit da view de skills, não foram distribuídas; o resultado está consolidado nesta entrada.

### Adicionado

- Lista de skills no painel do launcher, alternando com Conversas e Mudanças por uma barra de abas no topo do painel, com busca e filtros **Projeto**, **Global** e **claude.ai**. Permite abrir o `SKILL.md`, ativar ou desativar, criar e excluir (para a lixeira) skills do projeto e globais. As skills sincronizadas do claude.ai são somente leitura.

### Alterado

- A view do launcher passou a se chamar **Claude Code Launcher** e a view separada de skills deixou de existir. Os comandos **Mostrar skills** e **Mostrar conversas e mudanças** alternam as abas; **Mudanças** fica oculta na aba Skills. O comando **Abrir lista de skills** foi removido.

## 0.11.0 — 2026-11-19

### Corrigido

- A captura parava depois de cerca de dez mil edições: cada edição deixava um marcador em `completed/` que nada removia, até a pasta passar do orçamento de inventário do hook. A janela dona da revisão agora recolhe marcadores e preparações com mais de 24 horas e as cópias de `review-blobs/v1/` sem referência, ao abrir, a cada seis horas e em **Limpar histórico revisado**.
- Um hook interrompido no meio da execução deixava um registro em `active/` que bloqueava para sempre a retenção, **Limpar histórico revisado** e **Apagar todos os dados locais de revisão**. A manutenção agora remove registros comprovadamente órfãos.
- Ao fechar ou recarregar a janela, a extensão espera a liberação da posse da revisão. Antes, a próxima janela podia abrir a revisão só para leitura.
- Desfazer a recusa de um arquivo criado pelo Claude o recriava com permissão `0600`. O arquivo agora nasce com a permissão padrão do sistema.
- Mensagens ao usuário mostravam códigos internos, como `execArgumentsNotConfirmed`. Agora explicam o motivo.
- **Apagar todos os dados locais de revisão** e **Recuperar revisão bloqueada** tratavam pastas de providers virtuais como caminhos de disco.

### Alterado

- Aceitar e recusar bloqueiam menos o editor: o estado da revisão deixou de reler todas as cópias de conteúdo a cada gravação e de regravar o estado quando nada mudou.
- O script do hook copiado para o projeto é conferido a cada atualização do painel e restaurado quando difere do distribuído pela extensão.
- O painel avisa quando o registro está configurado e o comando `node` não é encontrado no `PATH`.
- `claudeCodeLauncher.hookExecutionMode` passou a ser uma opção da máquina; o `settings.json` de um projeto não a altera mais.
- No macOS, os atalhos de navegação entre trechos passaram a `Ctrl+Alt+]` e `Ctrl+Alt+[`, porque `Option+]` e `Option+[` digitam caracteres.
- O manifesto declara suporte limitado a workspaces virtuais: revisão e registro exigem pastas no disco local.
- O painel é republicado uma vez por rajada de digitação em um arquivo sob revisão.
- Uma janela que encontra a posse da revisão deixada por um processo que não existe mais oferece **Recuperar revisão**, em vez de depender de o usuário achar o comando. A posse continua não sendo assumida sozinha.
- Os padrões de `claudeCodeLauncher.historyExcludedPatterns` definidos no `settings.json` de um projeto passam a somar-se aos do usuário; não os substituem mais.
- O contêiner da barra de atividades chama-se **Claude Code Launcher** e a view de conversas, **Conversas**, para não se confundirem com a extensão oficial. A extensão ganhou ícone de listagem e a descrição informa que é independente da Anthropic.

### Interno

- O código passou a usar os tipos do Node (`@types/node`) no lugar de `require` sem tipo, o que revelou três caminhos possivelmente indefinidos, agora tratados.
- ESLint com regras de correção (promessas soltas, igualdade estrita, `switch` exaustivo) entrou no projeto e na CI.
- `noUnusedLocals`, `noImplicitReturns` e `noFallthroughCasesInSwitch` ligados; código morto removido.
- A apresentação das mudanças saiu de `changes.ts` para `changes-view.ts`, sem dependência do editor.

## 0.10.0

- Resultados de revisão por arquivo, contratos de privacidade e de recuperação.

## 0.9.0

- Diagnóstico de captura e teste de integração do VSIX instalado.

## 0.8.0

- Correção da captura de mudanças no Windows e nova interface do painel.

## 0.7.0

- Histórico em blobs, revisão compartilhada entre editores e suporte a várias pastas.

## 0.6.0

- Revisão de mudanças com pendentes, desfazer, navegação e testes.
