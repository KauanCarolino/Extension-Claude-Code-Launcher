# Launcher for Claude Code

Extensão para Cursor e Visual Studio Code que abre o chat oficial do Claude Code e permite revisar, no painel e no editor, as alterações realizadas por ele.

O chat, a autenticação, os modelos e as permissões são de responsabilidade da extensão oficial **Claude Code** (`anthropic.claude-code`). O launcher utiliza essa integração e não incorpora o Agent do Cursor.

Esta é uma extensão independente, que não constitui produto da Anthropic nem é por ela mantida. "Claude" e "Claude Code" são marcas da Anthropic.

**Versão:** 1.0.0 · **Pacote local:** `launcher-for-claude-code-1.0.0.vsix`

## Em resumo

- **Abrir o chat** do Claude Code na barra lateral ou em abas, por um ícone no título do editor ou pelo item **Claude** na barra de status.
- **Revisar mudanças:** ver, arquivo por arquivo, o que o Claude alterou, com diff, aceitar, recusar e desfazer.
- **Gerenciar skills** em um painel próprio.

### Começando em 3 passos

1. Instale a extensão oficial **Claude Code** (o launcher oferece a ação **Instalar**).
2. Abra a pasta do projeto e clique no item **Claude** na barra de status.
3. Para acompanhar as mudanças, execute **Ativar registro de mudanças** e inicie uma nova conversa.

Tudo fica local: nenhum dado é enviado a serviço externo.

## Sumário

1. [Requisitos e compatibilidade](#requisitos-e-compatibilidade)
2. [Instalação](#instalação)
3. [Conversas](#conversas)
4. [Gerenciamento de skills](#gerenciamento-de-skills)
5. [Revisão de mudanças](#revisão-de-mudanças)
6. [Hooks e dados locais](#hooks-e-dados-locais)
7. [Comandos operacionais](#comandos-operacionais)
8. [Desenvolvimento e validação](#desenvolvimento-e-validação)

## Requisitos e compatibilidade

- Visual Studio Code **1.94.0 ou superior**. No Cursor, a API do editor deve ser compatível; os alvos verificados constam na tabela abaixo.
- Extensão oficial Claude Code, necessária para abrir conversas. Sua instalação ocorre somente mediante a ação explícita **Instalar**.
- Workspace confiável e arquivos locais, necessários para a revisão e a captura. O launcher permanece desabilitado no Restricted Mode.
- Node.js **22 ou superior** no `PATH`, tanto para o fluxo de desenvolvimento quanto para a execução do hook local. O Node embutido no Extension Host é independente do Node do terminal. Quando o registro está configurado e o comando `node` não é localizado no `PATH` da janela, o painel **Mudanças** emite um aviso, que cessa assim que um evento de captura é observado.
- Em workspaces virtuais, a revisão e o registro ficam indisponíveis, pois exigem pastas no disco local. A abertura do chat depende do suporte da extensão oficial a esse tipo de workspace, o que não foi verificado.

| Editor | Alvos do teste de host |
| --- | --- |
| VS Code 1.94.0, Node do host 20.16.0 | macOS arm64 local; Linux, Windows e macOS na CI |
| VS Code 1.146.0, Node do host 24.22.1 | macOS arm64 |
| Cursor 3.19.13, API VS Code 1.128.0, Node do host 24.18.1 | macOS arm64 |
| VS Code 1.147.0, Node do host 24.22.1 | Linux x64 (1.0.0: host, `multi-window`, `lifecycle` e `official` com Claude Code 2.1.329) |
| Cursor 3.30.14, API VS Code 1.128.0, Node do host 24.22.1 | Linux x64 (1.0.0: host) |

A abrangência dos testes, o que eles não comprovam e a verificação de hooks estão em [docs/VERIFICACAO.md](https://github.com/KauanCarolino/Extension-Claude-Code-Launcher/blob/main/docs/VERIFICACAO.md).

## Instalação

1. Em **Extensions**, abrir o menu `…` e selecionar **Install from VSIX**.
2. Selecionar o arquivo `launcher-for-claude-code-1.0.0.vsix`.
3. Abrir a pasta do projeto e executar um comando da categoria **Launcher for Claude Code**.
4. Para registrar novas mudanças, executar **Ativar registro de mudanças** e iniciar uma nova conversa do Claude.

A atualização do pacote não publica a extensão nem envia o histórico a serviço externo. Os dados locais podem conter código e trechos de conversas; a política de armazenamento é descrita na seção [Hooks e dados locais](#hooks-e-dados-locais).

## Conversas

O ícone de balão no título do editor e o item **Claude** na barra de status abrem a barra lateral oficial. Os comandos **Nova conversa em aba** e **Abrir chat em nova aba** utilizam o editor de conversas do Claude.

O contêiner **Launcher for Claude Code**, na barra de atividades, contém a view homônima, que apresenta uma barra de abas no topo: **Conversas** e **Skills** (consulte [Gerenciamento de skills](#gerenciamento-de-skills)). A aba **Conversas** exibe:

- **Nova conversa**, que abre uma conversa nova em aba;
- uma lista de conversas, com uma linha por item e o tempo à direita:
  - **Abertas**: conversas abertas em aba, com ponto cheio na aba ativa e vazado nas demais. O clique move o foco para a aba; o botão **×**, exibido ao passar o ponteiro, fecha-a;
  - **Hoje**, **Ontem**, **Esta semana**, **Este mês** e **Mais antigas**: até 15 conversas recentes das pastas locais do workspace, excluídas as já abertas. O clique retoma a conversa em uma aba;
- **Buscar conversas**, disponível quando a lista excede 6 conversas. A busca desconsidera acentos e diferenças entre maiúsculas e minúsculas, e `Esc` limpa o campo.

O título da view oferece as ações **Nova conversa** e **Atualizar conversas**. A aba selecionada é preservada pela view, e os comandos **Mostrar skills** e **Mostrar conversas e mudanças** também alternam entre elas. A lista é operável por teclado: `Tab` move o foco para ela e as setas para cima e para baixo percorrem as linhas.

Os títulos são obtidos de `~/.claude/projects/` ou de `CLAUDE_CONFIG_DIR`, quando definido. A leitura é assíncrona, utiliza cache limitado e sinaliza quando a lista é parcial. Resultados de uma view já fechada são descartados.

O launcher informa quando a extensão oficial está ausente, quando a ativação excede o tempo esperado, quando o comando não está disponível e quando a abertura da aba não é confirmada. Erros de autenticação informados pelo Claude orientam o usuário a efetuar login. O launcher não dispõe de API pública para consultar o estado de login, e a existência de uma aba aberta não comprova que uma nova conversa foi iniciada. Quando necessário, o endereço de abertura utiliza o protocolo do editor em uso, inclusive `cursor://`.

### Organização de grupos do editor

A organização automática dos grupos vem **desabilitada** por padrão. A opção `claudeCodeLauncher.manageEditorGroups` separa os arquivos do grupo do chat e gerencia as preferências de abertura. Ao ser desabilitada, somente os valores ainda pertencentes à extensão são restaurados. Uma alteração manual posterior encerra a gestão do respectivo valor até que a opção seja desabilitada e habilitada novamente. Um workspace distinto com a opção desabilitada não restaura as preferências geridas pelo workspace atual.

## Gerenciamento de skills

A aba **Skills** lista as skills do Claude Code, com busca e os seguintes filtros:

| Filtro | Origem |
| --- | --- |
| **Projeto** | `.claude/skills/` da primeira pasta do workspace |
| **Global** | `~/.claude/skills/`, ou `$CLAUDE_CONFIG_DIR/skills/` quando a variável está definida |
| **claude.ai** | Skills sincronizadas; somente leitura |

Enquanto a aba **Skills** está ativa, a view **Mudanças** permanece oculta, sendo exibida novamente ao se selecionar **Conversas**.

Para skills do projeto e globais, estão disponíveis as seguintes operações:

- **Abrir** o `SKILL.md` ou **revelar** a pasta no sistema;
- **Ativar ou desativar**: o arquivo `SKILL.md` é renomeado para `SKILL.md.disabled`, e a skill deixa de ser carregada pelo Claude. Essa é uma convenção do launcher, não um recurso do Claude Code: o Claude Code apenas deixa de encontrar o `SKILL.md`. Para reativar sem o launcher, basta renomear o arquivo de volta;
- **Criar**, informando nome (letras minúsculas, números e hífens) e descrição; o `SKILL.md` criado é aberto no editor;
- **Excluir**, mediante confirmação; a pasta é enviada à lixeira do sistema.

A lista é atualizada quando há alterações em disco. Sem pasta aberta, são exibidas apenas as skills globais e as do claude.ai.

## Revisão de mudanças

A view **Mudanças** reúne as edições capturadas pelas ferramentas Edit, Write, MultiEdit e NotebookEdit. A captura de um evento de notebook não implica que a reversão correspondente esteja habilitada.

### Escopo por conversa

O painel exibe somente os arquivos da conversa em foco e acompanha a troca de conversa. Um aviso no topo indica a conversa apresentada, e a ação **Ver todas** inclui também as alterações de outras conversas (a ação **Só esta conversa** restabelece o filtro). Quando nenhuma conversa é identificada, como no caso de uma conversa nova ainda sem mensagens, o painel exibe todas as alterações.

A aba do chat oficial expõe apenas o título, por isso a conversa é identificada comparando esse título com o das conversas gravadas. Daí decorrem três limites:

- Conversas com o **mesmo título** não são distinguidas. O painel mostra as mudanças de todas elas juntas e o aviso informa quantas conversas têm aquele título.
- Se o título da aba **não coincidir exatamente** com o gravado (por exemplo, abreviado pelo editor), nenhuma conversa é identificada e o painel mostra tudo.
- O filtro só muda **o que aparece** no painel. Aceitar e recusar continuam valendo para o arquivo inteiro, inclusive para trechos de outras conversas no mesmo arquivo.

### Painel lateral

O bloco **Para revisar** lista os arquivos pendentes, com as contagens `+`/`−` e a indicação **novo** ou **apagado**. Os botões **✓** e **✕**, ao final de cada linha, aceitam ou recusam o arquivo; o clique na linha abre a revisão no código. O painel apresenta decisões parciais, a fase da revisão e os bloqueios por arquivo. Um arquivo bloqueado tem as ações desabilitadas, com indicação do motivo e orientação para retomar a revisão.

O histórico é apresentado como lista compacta, sem diff, agrupada por dia e pelo pedido que originou as edições. Cada linha exibe o status, o arquivo, as contagens `+`/`−` e o momento da edição:

| Indicador | Significado |
| --- | --- |
| Ponto laranja | Pendente de revisão |
| ✓ | Aceita |
| ↶ | Recusada |
| ✓ em laranja | Revisão **mista** |

O clique em uma linha exibe a mudança no código, e o ícone de diff, mostrado ao passar o ponteiro, abre a comparação antes/depois daquela edição. O tooltip apresenta o resumo e a explicação registrada pelo Claude. A ação **Desfazer pedido** é exibida ao passar o ponteiro sobre o pedido. O link **Ver os diffs na tela maior**, ao final da lista, abre o painel completo.

O estado é exibido ao lado do título da view (**Registro configurado**, **Registro desligado** ou **Somente leitura**), e a quantidade de arquivos a revisar é indicada no ícone do Claude Code na barra de atividades. **Registro configurado** indica a presença dos handlers; a observação e a conclusão das capturas são apresentadas separadamente no diagnóstico.

As ações disponíveis no título da view são:

- **Recuperar revisão bloqueada**, quando a janela está em modo somente leitura, e **Desfazer recusa**, quando há recusa a desfazer;
- **Atualizar** e **Tela maior**;
- no menu `...`: aceitar ou recusar todas as pendentes, ligar ou desligar as marcas no código, ativar ou desligar o registro, **Limpar histórico revisado**, **Apagar todos os dados locais de revisão** e **Liberar revisão para outra janela**.

### Tela maior

A **tela maior** abre o mesmo painel em uma aba, com as ações na barra superior. Cada edição é apresentada como um cartão com o resumo, o pedido e a explicação localizados no transcript, além dos trechos de diff, com alternador **Unificado / Lado a lado**. Trechos com mais de 60 linhas iniciam recolhidos. Os cartões abertos, o bloco recolhido e a legenda são preservados ao reabrir o painel, e a rolagem não se desloca quando uma nova mudança é recebida. Quando a revisão está em modo somente leitura, os botões que a alteram permanecem desabilitados, e um aviso explicita o motivo.

### Semântica das decisões

- **Aceitar** mantém o conteúdo e registra a decisão. A aceitação de um trecho incorpora apenas esse trecho à base da revisão.
- **Recusar** restaura somente a parte ainda pendente. Uma parte aceita no editor permanece aceita ao se utilizar o painel ou ao recarregar a janela.
- Uma revisão com partes aceitas e recusadas recebe o estado **misto**. Edições contínuas abrangidas pela decisão têm todos os seus identificadores representados.
- Edições humanas, mudanças externas, identidade ambígua e snapshots insuficientes estabelecem barreiras. A ação pode ficar bloqueada ou atingir apenas o segmento contínuo comprovado; o launcher não retrocede através de uma edição humana para completar o lote.
- A recusa de um arquivo criado restaura sua **ausência**. Arquivo vazio e arquivo inexistente são situações distintas. As exclusões utilizam a lixeira, e uma falha não provoca tentativa de exclusão permanente.
- Uma decisão que altera conteúdo só é concluída após aplicar, salvar e verificar o resultado. Uma falha de salvamento não é apresentada como recusa concluída. O resultado distingue a alteração do conteúdo, o salvamento e a persistência da decisão; cancelamentos, conflitos e recuperação pendente recebem orientação específica por arquivo.
- **Desfazer a última recusa** utiliza recuperação persistida por item. Itens conflitantes permanecem recuperáveis e não são consumidos como se houvessem sido restaurados. Uma intenção interrompida pode exigir reconciliação antes de nova ação.

### Revisão no editor

As lentes oferecem **Aceitar** e **Recusar** por trecho e, quando há vários trechos, as opções de aceitar ou recusar todos. O comando **Ocultar marcas** aceita as mudanças pendentes do arquivo; para ocultar apenas a apresentação, desabilita-se `claudeCodeLauncher.inlineChanges`.

O modo **Lado a lado** das lentes compara a base da revisão atual, inclusive com decisões parciais, ao arquivo observado. A comparação de um cartão exibe o antes/depois histórico da edição correspondente. As duas comparações respondem a perguntas distintas.

Arquivos pendentes recebem a letra **C** no Explorer, e a barra de status exibe a respectiva contagem. Os atalhos `Alt+]` e `Alt+[` percorrem os trechos; no macOS, onde essas teclas produzem caracteres, os atalhos são `Ctrl+Alt+]` e `Ctrl+Alt+[`. As cores são ajustáveis pelo tema, inclusive `claudeCodeLauncher.pendingChangeForeground`.

## Hooks e dados locais

A ativação do registro configura handlers próprios em `.claude/settings.local.json` e copia o script para `.claude/launcher-changes/`. O comando do hook utiliza executável e argumentos separados. Grupos mistos preservam os handlers de terceiros; JSON inválido ou alteração concorrente bloqueiam a atualização da configuração.

O modo `auto` exige capacidade comprovada no schema. O modo `exec` é uma escolha explícita, destinada a harness cuja compatibilidade com esse formato tenha sido verificada. O modo `disabled` desliga os hooks geridos. Não existe fallback automático por shell. O hook apenas observa a edição: uma falha de captura não autoriza nem impede a operação original do Claude.

Na atualização da extensão, o script dos hooks já configurados é reparado automaticamente, quando a capacidade, a política e a propriedade da escrita o permitem. Uma captura pausada permanece pausada. Os bloqueios são informados; para reativar o registro, utiliza-se **Ativar registro de mudanças** e inicia-se uma nova conversa, a fim de que o Claude carregue a configuração.

O script do hook reside na pasta do projeto e é executado a cada edição do Claude. A cada atualização do painel, a cópia é comparada com a distribuída pela extensão. A janela proprietária da revisão restaura uma cópia ausente ou divergente e, quando o conteúdo divergia, emite aviso; uma janela em modo somente leitura apenas informa a divergência. Essa conferência reduz o intervalo de validade de um script substituído, mas não impede sua execução antes da verificação.

### Diagnóstico de captura

A view **Mudanças** apresenta o diagnóstico por pasta do workspace, distinguindo quatro informações:

| Informação | O que comprova |
| --- | --- |
| Configuração | Os handlers próprios foram encontrados na configuração local |
| Capacidade de execução | O schema admite executável e argumentos separados, há escolha explícita de `exec` ou a capacidade permanece desconhecida |
| Observação | O hook registrou, com data, uma tentativa e a respectiva etapa |
| Conclusão conhecida | Há evidência de um evento gravado no histórico; a disponibilidade de conteúdo é indicada separadamente |

A configuração do hook não comprova que o Claude o executou, e um evento anterior à edição não comprova sua conclusão. O painel apresenta orientação para situações como pausa, quota, permissão, espaço, preparação ou gravação indisponível. Se uma tentativa falhar após uma captura concluída, a evidência anterior permanece datada e não representa atividade atual bem-sucedida.

Os diagnósticos utilizam registros imutáveis, com etapas e motivos admitidos, sem código, prompts, transcripts, caminhos absolutos ou exceções brutas. A leitura é limitada. Dados legados, incompatíveis ou ilegíveis, bem como leituras incompletas, aparecem como diagnóstico desconhecido ou parcial, preservadas as informações encontradas. Alterações nos diagnósticos podem atualizar o painel ainda que não haja nova entrada no histórico.

**A cobertura não é universal.** Os hooks abrangem Edit, Write, MultiEdit e NotebookEdit. Bash, PowerShell, MCP e alterações externas não são abrangidos por esse matcher. Conteúdo excluído, grande ou insuficiente não é apresentado como cópia integral. A disponibilidade de snapshots tampouco dispensa as verificações de conflitos e de recursos admitidos anteriores a uma reversão.

### Política de conteúdo

O histórico contém cópias locais em texto, sem criptografia própria. As exclusões padrão evitam novas cópias de `.env`, chaves privadas, certificados e determinados arquivos de credenciais. A política também impede novas cópias de pedidos e explicações relativos a arquivos excluídos, inclusive em eventos antigos. A alteração de uma exclusão não apaga cópias anteriores nem garante que todo segredo possível seja reconhecido. Arquivos acima de **512 KiB** não têm o conteúdo integral capturado.

| Configuração | Padrão | Efeito |
| --- | --- | --- |
| `claudeCodeLauncher.inlineChanges` | `true` | Exibe as marcas de revisão |
| `claudeCodeLauncher.manageEditorGroups` | `false` | Habilita a gestão de grupos e preferências |
| `claudeCodeLauncher.hookExecutionMode` | `auto` | `auto`, `exec` ou `disabled`. Opção da máquina: o `settings.json` de um projeto não a altera |
| `claudeCodeLauncher.historyExcludedPatterns` | Padrões de arquivos sensíveis | Exclusões de novas cópias; aceita `*`, `**` e `?`. Os padrões do `settings.json` de um projeto somam-se aos do usuário e não os substituem |
| `claudeCodeLauncher.historyRetentionDays` | `30` | Retenção do histórico revisado; `0` desabilita a limpeza por idade |
| `claudeCodeLauncher.historyMaxStorageMB` | `128` | Orçamento local, em MiB; ao atingir o limite, novas capturas são suspensas |

Pendências, decisões parciais e referências necessárias à recuperação não são descartadas para atender ao orçamento. Uma leitura parcial ou um registro inválido impede a declaração de que todo o histórico foi processado. O diagnóstico de entradas inválidas evita copiar novamente seu conteúdo para relatórios.

### Limpeza de dados

**Limpar histórico revisado** remove as entradas elegíveis do histórico, preservando revisões e recuperação. Por esse motivo, não equivale à liberação de todo o armazenamento.

A janela proprietária da revisão também recolhe, ao abrir e a cada seis horas, os itens que nenhum fluxo utiliza: marcadores de `completed/` e preparações de `pending/` com mais de 24 horas, e cópias de `review-blobs/v1/` não referenciadas pelo estado canônico, pela geração anterior ou pelos backups. **Limpar histórico revisado** executa a mesma coleta de imediato. Arquivos com nomes desconhecidos, capturas em andamento e cópias recentes são preservados.

**Apagar todos os dados locais de revisão** solicita confirmação, pausa a captura e exige que os produtores cooperantes estejam interrompidos. O comando remove os dados próprios de revisão e recuperação, mantendo os arquivos atuais do projeto e as configurações de terceiros. A captura permanece pausada até nova ativação pelo usuário. Falhas e conflitos são informados como limpeza parcial ou bloqueada, com inventário do que permaneceu por categoria e orientação para a nova tentativa. Um inventário incompleto não é apresentado como ausência de dados. O comando não apaga os transcripts originais do Claude, backups externos nem cópias no Git.

Uma limpeza interrompida mantém uma intenção mínima em `purge-state.v1.json`, sem conteúdo de arquivos ou conversas. Enquanto esse marcador existir, a versão 0.10 bloqueia a revisão e o reparo automático, a fim de evitar que os dados remanescentes sejam novamente ingeridos. Deve-se resolver a condição indicada e repetir **Apagar todos os dados locais de revisão**; o marcador não deve ser removido manualmente, pois só é eliminado após a conclusão das etapas de disco e de memória.

### Arquivos e recuperação

O diretório `.claude/launcher-changes/` é local e recebe regra de exclusão do Git. Não se deve forçar sua inclusão, pois pode conter código e metadados privados.

| Caminho | Responsabilidade |
| --- | --- |
| `log.jsonl`, `blobs/` | Eventos capturados e versões de conteúdo |
| `review-state.v1.json`, `.prev`, `review-blobs/v1/` | Estado canônico, geração anterior, decisões e recuperação |
| `status.json` | Projeção de decisões completas, para compatibilidade; o estado misto não é convertido em decisão homogênea |
| `review-writer.lock` | Propriedade cooperante da escrita de revisão |
| `review-migration-backups/` | Backups da migração e da recuperação |
| `purge-state.v1.json` | Intenção de limpeza preparada ou parcial; bloqueia a recriação automática até que nova tentativa explícita seja concluída |
| `meta.json` | Pedido e explicação associados aos eventos |
| `capture-policy.json`, `capture-status.json` | Política de captura, pausa e diagnóstico legado; isoladamente, não comprovam conclusão |
| `capture-diagnostics/v2/observations/`, `capture-diagnostics/v2/completions/` | Evidências separadas de tentativas e conclusões; retenção conservadora de 32 registros válidos por categoria, preservados os dados desconhecidos |
| `active/`, `pending/`, `completed/` | Coordenação e idempotência do hook; marcadores antigos são recolhidos automaticamente |

#### Propriedade da escrita

Apenas uma janela escreve a revisão de cada projeto por vez; as demais permanecem em modo somente leitura. A janela proprietária utiliza **Liberar revisão para outra janela**, e a janela que assumirá utiliza **Recuperar revisão bloqueada**. Um proprietário ativo ou ambíguo não é removido por idade do lock.

Após uma queda, a janela seguinte abre em modo somente leitura e, quando o processo registrado como proprietário não existe mais, oferece **Recuperar revisão** uma única vez. A posse nunca é assumida sem essa confirmação, pois a pasta pode estar aberta em outra máquina ou contêiner. O comando de recuperação verifica o proprietário.

Havendo um `review-recovery.lock` órfão, o procedimento é offline:

1. Encerrar todas as janelas e conversas que utilizam o projeto.
2. Fazer uma cópia de `.claude/launcher-changes/`.
3. Conferir o PID registrado.
4. Remover **somente esse guard**, após comprovar que o processo foi encerrado.

Não se deve remover o lock de uma janela ativa nem editar o estado canônico para forçar uma decisão. Um guard de manutenção de captura também exige quiescência e inspeção antes de qualquer intervenção.

#### Hooks interrompidos

Um hook interrompido durante a execução (tempo esgotado, queda do processo ou da máquina) deixa seu registro em `active/` e, por vezes, um marcador `.post` em `pending/`. A manutenção remove esses registros quando possuem o formato criado pelo hook, têm mais de 30 segundos e pertencem a processo que não existe mais; o marcador `.post` é removido quando não permanece nenhum registro em `active/`. Registros de processos ativos, recentes ou com nomes desconhecidos continuam bloqueando a manutenção.

#### Versões anteriores e downgrade

A partir da 1.0.0, os formatos versionados deste diretório são compatíveis dentro da série 1.x: uma versão 1.x lê o que qualquer 1.x anterior gravou. O compromisso completo está no [CHANGELOG](https://github.com/KauanCarolino/Extension-Claude-Code-Launcher/blob/main/CHANGELOG.md).

A versão 0.7.0 não participa desse protocolo. Não se deve manter versões antigas e novas escrevendo no mesmo projeto. Para realizar downgrade, devem-se encerrar os escritores e preservar o diretório de revisão, pois o formato antigo não representa decisões parciais, estado misto nem toda a recuperação atual. A reinstalação do executável anterior não desfaz o conteúdo dos arquivos.

As versões 0.8 e 0.9 também não reconhecem a intenção de limpeza introduzida na 0.10. Uma limpeza interrompida deve ser concluída com a versão 0.10 ou superior antes de se considerar um downgrade. O uso simultâneo dessas versões durante a limpeza não é suportado.

## Comandos operacionais

Todos os comandos constam na categoria **Launcher for Claude Code** da paleta, além das ações disponíveis nas views.

| Comando | Finalidade |
| --- | --- |
| Abrir chat na barra lateral / Abrir chat em nova aba | Abrir a integração oficial |
| Nova conversa em aba | Solicitar nova conversa |
| Instalar Claude Code | Instalar a extensão oficial, por ação explícita |
| Mostrar skills / Mostrar conversas e mudanças | Alternar as abas da view do launcher |
| Mostrar mudanças do Claude | Abrir o painel maior |
| Atualizar mudanças | Reler o histórico e o estado da revisão |
| Ativar / Desligar registro de mudanças | Gerir os hooks próprios |
| Limpar histórico revisado | Limpar o histórico elegível, mantendo a recuperação |
| Apagar todos os dados locais de revisão | Limpeza completa coordenada, com confirmação |
| Liberar revisão para outra janela | Encerrar a propriedade local da revisão |
| Recuperar revisão bloqueada | Assumir uma revisão liberada ou recuperar proprietário comprovadamente encerrado |
| Aceitar / Recusar todas as mudanças pendentes do Claude | Revisar o lote admitido |
| Desfazer a última recusa | Recuperar o último lote, mantendo os itens que não puderem ser restaurados |
| Ligar/desligar marcas das mudanças no código | Alterar a apresentação inline |
| Próxima / Mudança anterior do Claude | Navegar pelos trechos |

## Desenvolvimento e validação

Requer-se Node.js 22 ou superior e o lockfile do projeto:

```sh
npm ci --ignore-scripts --no-audit --fund=false
npm run typecheck
npm run lint
npm test
npm run test:package
npm audit --audit-level=moderate
npm run package -- --out launcher-for-claude-code-1.0.0.vsix
npm run verify:package -- launcher-for-claude-code-1.0.0.vsix
```

O script `vscode:prepublish` executa o build, que remove a saída gerada anteriormente e compila com `noEmitOnError`. Os testes de pacote utilizam árvores temporárias, inclusive uma sem `out/` e outra com saída obsoleta. O verificador inspeciona o VSIX real, compara seus bytes com o runtime atual, calcula o SHA-256 e rejeita conteúdo inesperado. `docs/`, testes, scripts, configurações locais e dependências de desenvolvimento são excluídos do VSIX.

### Testes de host

Os testes de `test/*.test.js` utilizam regras reais e adaptadores explícitos nos casos em que o editor não está presente. Para testar o Extension Host, compila-se o projeto e executa-se:

```sh
npm run test:host -- --editor code
npm run test:host -- --editor cursor
npm run test:host -- --editor code --vsix launcher-for-claude-code-1.0.0.vsix --keep
npm run test:host -- --editor cursor --vsix launcher-for-claude-code-1.0.0.vsix --report-dir docs/validacao/host-cursor
```

O runner cria workspace, perfil, diretório de extensões e configuração Claude temporários. O modo `--vsix` instala e exercita o pacote nesse perfil isolado, sem alterar o perfil normal e sem enviar mensagens ao Claude. A opção `--keep` mantém o perfil temporário, e as falhas também preservam o diretório. A opção `--report-dir` cria uma subpasta `run-*` exclusiva para cada execução, com os relatórios e logs correspondentes, preservando as execuções anteriores. O cenário é um workspace sintético confiável e não constitui teste do Restricted Mode.

A jornada de captura do pacote confere o hash do hook instalado com sua entrada no VSIX, executa os eventos anterior e posterior com Node externo 22 ou superior, aguarda a ingestão pelas lentes públicas do editor e verifica uma recusa no documento, no disco e no estado persistido. Esse arquivo sintético não recebe eventos semeados diretamente no log. Os relatórios separam o Node externo do Node do Extension Host e vinculam o resultado ao hash do VSIX. Esse procedimento exercita o hook diretamente e não equivale a uma conversa autenticada nem à execução dos hooks pelo harness oficial do Claude.

A jornada de recusa de criação exige lixeira no sistema de arquivos do workspace, porque o launcher nunca exclui de forma permanente. Em Linux, quando o diretório temporário não tem lixeira (o `gio` informa "montagens internas do sistema"), aponta-se `TMPDIR` para uma pasta dentro da home, por exemplo `TMPDIR=$HOME/.cache/launcher-host npm run test:host -- ...`, removendo-a ao final.

No macOS, os caminhos padrão correspondem aos aplicativos em `/Applications`; em Linux, informa-se `--executable` (por exemplo, `/usr/share/code/code` ou `/usr/share/cursor/cursor`). Para outra instalação, utiliza-se `--executable /caminho/do/editor`. O caminho do CLI é derivado dessa instalação, e `--cli /caminho/Resources/app/out/cli.js` permite substituí-lo, desde que pertença à **mesma instalação**. Para baixar e exercitar uma versão exata do VS Code:

```sh
npm run test:host -- --download-version 1.94.0 --vsix launcher-for-claude-code-1.0.0.vsix --report-dir docs/validacao/host-minimum
```

A opção `--download-version` aceita apenas uma versão exata, somente para VS Code, e não pode ser combinada com `--executable` ou `--cli`. O download utiliza cache temporário fora do projeto. Em Linux sem display, o comando deve ser executado com `xvfb-run -a`. A matriz de CI inclui a instalação do VSIX e a jornada do hook no VS Code 1.94.0 em Linux, Windows e macOS, além de tipagem, testes Node, testes de pacote e auditoria. Recomenda-se consultar os checks e as evidências da execução do commit a ser distribuído.

### Avaliação de desempenho

Para medir a listagem de conversas com arquivos sintéticos, executa-se `node scripts/benchmark-sessions.cjs docs/validacao/sessoes.json`. Um segundo argumento aceita um módulo de baseline conhecido, para comparação pareada.

O relatório registra cinco amostras com 15, 1.000 e 5.000 arquivos por pasta, em duas pastas sintéticas, incluindo títulos ausentes e arquivos acima da janela de leitura. Cada combinação utiliza um processo novo, com uma amostra fria e quatro aquecidas. São medidos a conclusão, a disponibilidade do event loop, as chamadas de IO, os bytes lidos e a variação de heap após GC explícito, além do registro dos hashes dos módulos. A memória do processo e a sonda de timer incluem ruído do runtime e não representam um SLA. O cache do sistema operacional não é limpo. A listagem utiliza até oito operações de stat simultâneas, 10.000 candidatos e 256 leituras de título por chamada; esses limites não constituem promessa de latência.

### Contratos adicionais

Os contratos adicionais também utilizam o VSIX instalado em perfis isolados:

```sh
npm run test:host:contracts -- multi-window --vsix launcher-for-claude-code-1.0.0.vsix --report-dir docs/validacao/janelas
npm run test:host:contracts -- lifecycle --vsix launcher-for-claude-code-1.0.0.vsix --report-dir docs/validacao/lifecycle
npm run test:host:contracts -- official --official-extension /caminho/da/extensao/anthropic.claude-code --vsix launcher-for-claude-code-1.0.0.vsix --report-dir docs/validacao/oficial
```

- **`multi-window`** exercita duas janelas reais, recarregamento, decisão parcial e transferência explícita da escrita.
- **`lifecycle`** mede a ativação pública e instancia os componentes empacotados de revisão e de lista de conversas, com um contexto real e um observador que encaminha chamadas às APIs reais. Repete painéis, troca de pastas e descarte durante o refresh. O provider privado da lista é exposto somente no carregador de teste, sem alterar o código distribuído, e a view real recebe mil sessões sintéticas. Os contadores pertencem à instância observada e não representam todos os recursos do editor.
- **`official`** copia somente os arquivos de programa da extensão oficial já instalada para o diretório temporário, consulta o estado do CLI isolado e verifica uma aba oficial aberta, sem enviar mensagem. Utiliza também o modo público [`--init-only`](https://code.claude.com/docs/en/hooks#setup) para testar o descritor de executável e argumentos em um evento Setup sintético, inclusive nos casos de erro e de timeout. O evento Setup não equivale aos eventos de captura PreToolUse/PostToolUse, que continuam identificados separadamente.

Nenhum desses cenários comprova uma conversa autenticada nem a execução do hook pelo modelo. A matriz de CI inclui os contratos de janelas e de lifecycle; o contrato `official` depende de uma instalação local compatível com o sistema.

### Documentação interna e publicação

Os PRDs, specs e registros de implementação em `docs/` são locais e estão ignorados pelo Git; não se deve utilizar `git add -f docs/`. A exceção é `docs/VERIFICACAO.md`, versionado porque o README aponta para ele. A geração de um VSIX não executa commit, push nem publicação em Marketplace ou Open VSX.

A publicação é feita pelo workflow `.github/workflows/release.yml`, disparado por uma tag `vX.Y.Z`:

1. Atualizar `version` no `package.json` e no `package-lock.json` e criar a seção `## X.Y.Z — data` no `CHANGELOG.md`.
2. Conferir os checks de **Validate extension** do commit nos três sistemas.
3. Criar e enviar a tag: `git tag vX.Y.Z && git push origin vX.Y.Z`.

O workflow recusa uma tag que não coincida com o `package.json` ou sem seção no CHANGELOG. Ele repete as validações e o teste de host, gera e verifica o VSIX, e o publica no Visual Studio Marketplace (segredo `VSCE_PAT`) e no Open VSX (segredo `OVSX_PAT`, de onde o Cursor instala). Um registro sem segredo é pulado com aviso. O VSIX verificado é anexado a uma release do GitHub, com as notas tiradas do CHANGELOG. O job de publicação usa o ambiente `release`, que pode exigir aprovação manual nas configurações do repositório.
