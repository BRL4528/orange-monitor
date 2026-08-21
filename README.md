# orange-monitor

Widget flutuante (Electron) tema dark/orange, fonte Fira Code. Mostra:

- CPU, RAM e espaço livre em disco do notebook
- Tokens do Claude Code (hoje e total, via `~/.claude/stats-cache.json`)
- Consumo da Central de Agentes: tokens ao vivo por workspace/conta e processos/CPU dos agentes ativos (via `~/.local/share/central-agentes/consumo-workspaces.json`)
- Limites Anthropic por conta (5 horas, semanal, semanal por modelo e créditos), com contagem de quanto falta para reiniciar. Descobre as contas em `~/.config/central-agentes/contas/claude/*` e consulta `GET https://api.anthropic.com/api/oauth/usage` com o token OAuth já salvo localmente por cada conta. O token nunca é enviado a nenhum lugar além da própria Anthropic; a consulta é refeita a cada 5min (esse endpoint é [conhecido por travar em 429 por horas](https://github.com/anthropics/claude-code/issues/31021) se martelado — em caso de 429 o widget espera 5min e dobra a cada falha repetida, até 30min, mostrando "tenta de novo em Xmin" e mantendo o último dado bom conhecido na tela).

Janela sem borda, sempre no topo, arrastável, atualiza a cada 3s. Ícone na bandeja do sistema (clique: mostrar/ocultar; menu: Mostrar/Ocultar e Sair). O botão × da janela apenas oculta — para fechar de vez, use "Sair" no menu da bandeja.

## Uso

```bash
npm install
npm start
```

Requer Linux com Claude Code / Central de Agentes instalados nos caminhos padrão. Instale a fonte [Fira Code](https://github.com/tonsky/FiraCode) para o visual completo (cai para monospace do sistema se ausente).
