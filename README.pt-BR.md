# Launcher for Claude Code

[Read in English](https://github.com/KauanCarolino/Extension-Claude-Code-Launcher/blob/main/README.md)

Abre o chat oficial do Claude Code no VS Code e no Cursor e mostra, arquivo por arquivo, o que o Claude mudou, para você aceitar ou recusar cada mudança.

Extensão independente: não é feita nem mantida pela Anthropic. "Claude" e "Claude Code" são marcas da Anthropic.

## O que ela faz

- **Abre o chat** na barra lateral ou em abas do editor, pelo ícone no título do editor ou pelo item **Claude** na barra de status. A view do launcher lista as conversas do projeto para você retomar qualquer uma.
- **Revisa as mudanças do Claude.** Cada arquivo que o Claude edita aparece em **Mudanças**, com o diff e o que ele disse antes de editar. Aceite ou recuse o arquivo inteiro ou um trecho, no painel ou direto no editor, e desfaça uma recusa.
- **Avisa o que a revisão não vê.** Quando o Claude roda um comando de terminal que pode ter gravado arquivos, o painel avisa e aponta o controle de código-fonte.
- **Gerencia skills, regras, agentes e servidores MCP** em abas próprias, inclusive em workspaces com várias pastas.

O chat, o login, os modelos e as permissões continuam com a extensão oficial **Claude Code** (`anthropic.claude-code`).

## Começando

O passo a passo (**Launcher for Claude Code: Abrir o passo a passo**) abre na instalação e percorre estas etapas:

1. Instalar a extensão oficial do Claude Code. O launcher oferece o botão **Instalar**.
2. Abrir a pasta do projeto.
3. Executar **Ativar registro de mudanças**. O hook roda com `node`, então o Node.js precisa estar no `PATH`.
4. Começar uma conversa **nova** e pedir uma edição. O Claude carrega os hooks ao iniciar a conversa; as que já estavam abertas não registram nada.
5. Revisar a mudança em **Mudanças** ou no editor. `Alt+]` e `Alt+[` passam de um trecho a outro (`Ctrl+Alt+]` e `Ctrl+Alt+[` no macOS).

## Privacidade e dados locais

- Tudo fica no seu disco. Nada é enviado a serviço externo.
- O registro adiciona dois hooks ao `.claude/settings.local.json` do projeto e guarda as cópias em `.claude/launcher-changes/`, que ganha um `.gitignore` próprio. O hook só observa: ele nunca aprova nem bloqueia uma ferramenta.
- Arquivos `.env`, chaves privadas, certificados e arquivos de credenciais não são copiados por padrão (`claudeCodeLauncher.historyExcludedPatterns`). O histórico revisado é limpo depois de 30 dias.
- A captura cobre Edit, Write, MultiEdit e NotebookEdit. Comandos de terminal, ferramentas MCP e mudanças feitas fora do Claude não são capturados.

## Requisitos

- VS Code 1.94 ou mais novo, ou um Cursor compatível.
- A extensão oficial Claude Code.
- Node.js 22 ou mais novo no `PATH`, para o registro de mudanças.
- Workspace confiável, em pastas locais. No Restricted Mode, o launcher fica desligado.

## Configurações

| Configuração | Padrão | O que faz |
| --- | --- | --- |
| `claudeCodeLauncher.language` | `auto` | Idioma da interface: `auto` segue o editor (português ou inglês), ou escolha `en` ou `pt-br` |
| `claudeCodeLauncher.inlineChanges` | `true` | Mostra as marcas da revisão no editor |
| `claudeCodeLauncher.historyExcludedPatterns` | arquivos sensíveis | Caminhos que nunca são copiados para o histórico |
| `claudeCodeLauncher.historyRetentionDays` | `30` | Dias de histórico revisado; `0` mantém tudo |
| `claudeCodeLauncher.historyMaxStorageMB` | `128` | Orçamento de armazenamento; ao atingi-lo, novas capturas pausam |
| `claudeCodeLauncher.manageEditorGroups` | `false` | Deixa o launcher tirar abas de arquivo do grupo do chat |
| `claudeCodeLauncher.hookExecutionMode` | `auto` | Como o hook é registrado; `disabled` desliga |

## Mais detalhes

- [Referência completa](https://github.com/KauanCarolino/Extension-Claude-Code-Launcher/blob/main/docs/REFERENCIA.md): semântica da revisão, diagnóstico de captura, dados locais, recuperação e desenvolvimento.
- [O que os testes comprovam](https://github.com/KauanCarolino/Extension-Claude-Code-Launcher/blob/main/docs/VERIFICACAO.md).
- [Changelog](https://github.com/KauanCarolino/Extension-Claude-Code-Launcher/blob/main/CHANGELOG.md).

Licença MIT.
