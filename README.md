# orange-monitor

Widget flutuante (Electron) tema dark/orange, fonte Fira Code. Mostra:

- CPU, RAM e espaço livre em disco do notebook
- Tokens do Claude Code (hoje e total, via `~/.claude/stats-cache.json`)
- Consumo da Central de Agentes: tokens ao vivo por workspace e processos/CPU dos agentes ativos (via `~/.local/share/central-agentes/consumo-workspaces.json`)

Janela sem borda, sempre no topo, arrastável, atualiza a cada 3s.

## Uso

```bash
npm install
npm start
```

Requer Linux com Claude Code / Central de Agentes instalados nos caminhos padrão. Instale a fonte [Fira Code](https://github.com/tonsky/FiraCode) para o visual completo (cai para monospace do sistema se ausente).
