# Changelog

## 0.13.0 — 2026-11-20

### Adicionado

- O painel **Mudanças** agora mostra só os arquivos da conversa em foco. Ao trocar de conversa, a lista acompanha. Um aviso no topo indica qual conversa está sendo mostrada, e **Ver todas** mostra também as de outras conversas. Sem conversa identificada (por exemplo, uma conversa nova ainda sem mensagens), o painel mostra tudo.

## 0.12.5 — 2026-11-20

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
