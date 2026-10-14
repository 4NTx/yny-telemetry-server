# YNY Modpack - Servidor de Telemetria e Painel de Auditoria

Backend leve e de alta performance desenvolvido em Node.js com Express e SQLite3 para receber, registrar e auditar eventos legítimos de uso da modpack do Minecraft (instalações, conexões em servidores, nicks e clãs).

Inclui um **Painel Web em tempo real** construído com TailwindCSS para monitoramento visual dos jogadores, auditoria por ID de instalação e busca rápida.

---

## 🚀 Como Executar

### Opção 1: Via Docker / Docker Compose (Recomendado)

```bash
# Iniciar o servidor em background
docker compose up -d --build

# Ver logs em tempo real
docker compose logs -f
```

Configure `CLIENT_TOKEN` com o mesmo valor usado pelo cliente e uma `ADMIN_KEY` exclusiva no ambiente (ou em um arquivo `.env` do Docker Compose). O serviço recusa iniciar sem essas variáveis.

O servidor estará rodando em: `http://localhost:3000`  
Painel de auditoria: `http://localhost:3000/index.html`

### Opção 2: Diretamente com Node.js (v18+)

```bash
npm install
npm start
```

---

## ⚙️ Variáveis de Ambiente

| Variável | Padrão | Descrição |
| :--- | :--- | :--- |
| `PORT` | `3000` | Porta HTTP do serviço |
| `CLIENT_TOKEN` | obrigatório | Token secreto esperado no cabeçalho `x-client-token` |
| `ADMIN_KEY` | obrigatório | Chave de autenticação para acessar os endpoints administrativos e o painel web |
| `DATA_DIR` | `./data` | Diretório onde o arquivo SQLite `telemetry.db` será salvo |

---

## 📡 API Endpoints

### 1. Ingestão de Eventos (Público/Cliente)
- **POST** `/api/telemetry/event`
- **Headers**:
  - `Content-Type: application/json`
  - `x-client-token: <CLIENT_TOKEN>`
- **Body JSON**:
```json
{
  "installId": "8a7b1c4d-9e0f-4a5b-8c7d-1e2f3a4b5c6d",
  "shortId": "8F3A92C1",
  "nick": "PlayerNick",
  "server": "jogar.craftlandia.com.br",
  "clan": "YNY",
  "version": "1.0.0",
  "eventType": "SERVER_JOIN",
  "timestamp": 1718000000000
}
```
- **Retorno**: `200 OK` `{"ok": true, "id": 1}`

### 2. Painel Administrativo & Estatísticas
- **Headers**: `x-admin-key: <ADMIN_KEY>`
- **GET** `/api/admin/stats`: Métricas globais (instalações únicas, nicks distintos, ativos recentes, total de eventos).
- **GET** `/api/admin/installations?search=...`: Lista instalações com agregação de nicks utilizados pelo mesmo computador.
- **GET** `/api/admin/events?search=...&limit=100`: Histórico detalhado de auditoria.

---

## 🌐 Configuração de Reverse Proxy (Nginx)

```nginx
server {
    listen 80;
    server_name telemetria.seudominio.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

## Logs de diagnóstico remotos

O cliente YNYUtils envia os registros do `DebugLog` de todos os módulos e acompanha `logs/latest.log` e os arquivos `.log`/`.log.gz` nas demais pastas de logs do jogo para `POST /api/telemetry/logs`, em lotes de até 25 partes. Mensagens longas são divididas em partes numeradas para caber no limite da API. Cada linha mantém ID da instalação, ID curto, nick e servidor capturados no momento do registro, horário, categoria e mensagem. O progresso da leitura do log geral fica em `logs/ynyutils/game-log-checkpoints.properties`. A fila fica em `logs/ynyutils/remote-pending/` até o servidor confirmar o lote. O reenvio usa o mesmo ID por linha para evitar duplicatas. Senhas, tokens e comandos de autenticação conhecidos são ocultados no envio; os logs locais continuam como antes.

Consulta administrativa: `GET /api/admin/logs?installId=...&category=...&search=...&limit=100&before=ID`, com o cabeçalho `x-admin-key`. O parâmetro `before` pagina para registros mais antigos. É necessário publicar esta versão do servidor para ativar o envio remoto do cliente atualizado.

Depois da confirmação do envio, o servidor guarda cada registro na tabela `diagnostic_logs` do SQLite `DATA_DIR/telemetry.db` (no Docker Compose, `/app/data/telemetry.db`, persistido em `server-telemetry/data/telemetry.db` no host). A fila `logs/ynyutils/remote-pending/` no cliente remove o arquivo confirmado. Os registros remotos expiram 30 minutos após `received_at`: o servidor os exclui na inicialização, a cada 30 segundos e antes de uma consulta administrativa. A consulta também filtra registros expirados. Essa regra se aplica somente a `diagnostic_logs`; os arquivos de log originais do jogo e as tabelas de identificação e eventos seguem suas políticas próprias.

A entrega depende de conexão, espaço em disco e do serviço remoto. Enquanto estiver offline, os arquivos ficam na fila local e são reenviados quando o jogo voltar a gerar logs. Quando a fila de escrita local enche, a chamada que gerou o log espera o gravador liberar espaço; isso preserva os registros, mas pode causar atraso no jogo durante uma sobrecarga. Falha de disco ou encerramento abrupto antes da gravação ainda podem impedir a entrega.
