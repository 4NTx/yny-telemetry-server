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
| `CLIENT_TOKEN` | `yny-modpack-client` | Token secreto esperado no cabeçalho `x-client-token` |
| `ADMIN_KEY` | `admin123` | Chave de autenticação para acessar os endpoints administrativos e o painel web |
| `DATA_DIR` | `./data` | Diretório onde o arquivo SQLite `telemetry.db` será salvo |

---

## 📡 API Endpoints

### 1. Ingestão de Eventos (Público/Cliente)
- **POST** `/api/telemetry/event`
- **Headers**:
  - `Content-Type: application/json`
  - `x-client-token: yny-modpack-client`
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
- **Headers**: `x-admin-key: admin123` (ou query param `?adminKey=admin123`)
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
