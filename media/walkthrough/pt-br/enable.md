# Como o registro funciona

Ao ativar, o launcher adiciona dois hooks em `.claude/settings.local.json` deste projeto. A cada edição do Claude (Edit, Write, MultiEdit, NotebookEdit), o hook guarda o conteúdo de antes e de depois.

- O hook só observa: ele não aprova nem bloqueia nenhuma ferramenta.
- Ele roda com o comando `node`, que precisa estar no `PATH`.
- Arquivos como `.env` e chaves privadas não são copiados. Confira as exclusões em **Configurações › Launcher for Claude Code**.
- Tudo fica no seu disco; nada é enviado a serviço externo.

Comandos de terminal (Bash, PowerShell) não passam pelo hook. Quando o Claude roda um comando que pode ter gravado arquivos, o painel **Mudanças** avisa.
