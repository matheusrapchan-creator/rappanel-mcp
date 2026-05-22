import "dotenv/config";
import express from "express";
import { randomUUID } from "crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const API_BASE_URL = process.env.API_BASE_URL || "https://api.raptech.com.br";
const API_TOKEN = process.env.API_TOKEN;
const PORT = process.env.PORT || 3100;

if (!API_TOKEN) throw new Error("API_TOKEN não configurado no .env");

const app = express();
app.use(express.json({ limit: "2mb" }));

const activeConnections = new Map();

async function apiRequest(path, options = {}) {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers: {
      "x-api-token": API_TOKEN,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });

  const text = await response.text();
  let data = null;

  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!response.ok) {
    throw new Error(typeof data === "string" ? data : JSON.stringify(data));
  }

  return data;
}

function formatMoney(value) {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
  }).format(Number(value || 0));
}

function formatAgenda(item) {
  return `${item.id}. ${item.titulo || "Sem título"} - ${item.cliente || "Sem cliente"} - ${item.data || "Sem data"} ${item.hora || ""} - ${item.status || "sem status"}`;
}

function formatOrcamento(item) {
  const opcao = item.opcao || item.marca_modulo || "Sem opção";
  const geracao = item.geracao_estimada_kwh ? `${item.geracao_estimada_kwh} kWh/mês` : "sem geração";
  return `${item.id}. ${item.cliente || "Sem cliente"} - ${opcao} - ${item.modulos || "-"} módulos - ${item.inversor || "-"} - ${geracao} - ${formatMoney(item.valor_venda)} - ${item.status || "sem status"}`;
}

function formatProjeto(item) {
  return `${item.id}. ${item.cliente || "Sem cliente"} - orçamento #${item.orcamento_id || "-"} - ${item.status || "sem status"}${item.observacao ? ` - ${item.observacao}` : ""}`;
}

function formatEstoque(item) {
  return `${item.id}. ${item.nome || "Item sem nome"} - ${item.categoria || "sem categoria"} - saldo ${Number(item.quantidade_atual || 0).toLocaleString("pt-BR")} ${item.unidade || "un"} - mínimo ${Number(item.estoque_minimo || 0).toLocaleString("pt-BR")} ${item.unidade || "un"} - ${item.localizacao || "sem local"}`;
}

function formatMovimentacao(item) {
  const nome = item.nome || item.produto_nome || `Item #${item.produto_id}`;
  return `${item.id}. ${item.tipo} - ${nome} - ${Number(item.quantidade || 0).toLocaleString("pt-BR")} ${item.unidade || ""}${item.projeto_id ? ` - projeto #${item.projeto_id}` : ""}${item.motivo ? ` - ${item.motivo}` : ""}`;
}

function formatRecebimento(item) {
  const vencimento = item.vencimento ? ` - venc. ${item.vencimento}` : "";
  return `${item.id}. ${item.cliente || "Sem cliente"} - ${formatMoney(item.valor)} - ${item.status || "a receber"}${vencimento}${item.observacao ? ` - ${item.observacao}` : ""}`;
}
function formatDetalhamento(item) {
  const rows = Array.isArray(item.detalhamento) ? item.detalhamento : [];
  if (!rows.length) return "Sem detalhamento de margem.";

  return rows
    .map((row) => {
      const valor = typeof row.valor === "number" ? formatMoney(row.valor) : row.valor || "-";
      return `- ${row.item || "Item"} | ${row.calculo || "-"} | ${valor}`;
    })
    .join("\n");
}

const idProperty = (label) => ({ type: "number", description: label });

const agendaProperties = {
  id: idProperty("ID do compromisso"),
  titulo: { type: "string", description: "Título do compromisso" },
  tipo: { type: "string", description: "Tipo: venda, suporte, instalação, visita, reunião" },
  data: { type: "string", description: "Data no formato YYYY-MM-DD" },
  hora: { type: "string", description: "Hora no formato HH:MM" },
  responsavel: { type: "string", description: "Responsável pelo compromisso" },
  cliente: { type: "string", description: "Nome do cliente" },
  endereco: { type: "string", description: "Endereço do compromisso" },
  status: { type: "string", description: "Status: agendado, em andamento, concluído, cancelado" },
  motivo_status: { type: "string", description: "Motivo da mudança de status" },
  observacao: { type: "string", description: "Observações gerais" },
  proxima_acao: { type: "string", description: "Próxima ação combinada" },
  data_proxima_acao: { type: "string", description: "Data da próxima ação no formato YYYY-MM-DD" },
};

const detalhamentoSchema = {
  type: "array",
  description: "Tabela de custos e margem do orçamento",
  items: {
    type: "object",
    properties: {
      item: { type: "string", description: "Nome do item" },
      calculo: { type: "string", description: "Fórmula usada" },
      valor: { type: "number", description: "Valor em reais" },
    },
    required: ["item"],
  },
};

const orcamentoProperties = {
  id: idProperty("ID do orçamento"),
  cliente: { type: "string", description: "Nome do cliente" },
  consumo_kwh: { type: "number", description: "Consumo mensal em kWh" },
  potencia_kwp: { type: "number", description: "Potência do sistema em kWp" },
  inversor: { type: "string", description: "Modelo do inversor" },
  modulos: { type: "number", description: "Quantidade de módulos" },
  marca_modulo: { type: "string", description: "Marca e modelo do módulo" },
  geracao_estimada_kwh: { type: "number", description: "Geração estimada mensal em kWh" },
  valor_venda: { type: "number", description: "Valor de venda do sistema" },
  opcao: { type: "string", description: "Identificação da opção" },
  modulo_nome: { type: "string", description: "Nome/marca do módulo" },
  modulo_potencia_w: { type: "number", description: "Potência do módulo em W" },
  total_material_dc: { type: "number", description: "Total de material DC em reais" },
  material_ac: { type: "number", description: "Custo de material AC em reais" },
  instalacao: { type: "number", description: "Custo de instalação em reais" },
  projeto: { type: "number", description: "Custo de projeto em reais" },
  lucro: { type: "number", description: "Lucro bruto previsto em reais" },
  lucro_com_desconto_5: { type: "number", description: "Lucro previsto com 5% de desconto" },
  margem_percentual: { type: "number", description: "Margem percentual prevista" },
  detalhamento: detalhamentoSchema,
  status: { type: "string", description: "Status: criado, enviado, em negociação, fechado, recusado, cancelado" },
  observacao: { type: "string", description: "Observações adicionais" },
};

const projetoProperties = {
  id: idProperty("ID do projeto"),
  orcamento_id: idProperty("ID do orçamento que virou projeto"),
  cliente: { type: "string", description: "Nome do cliente" },
  status: { type: "string", description: "Status: aguardando documentação, aguardando assinatura, aguardando dados técnicos, pronto para fazer, enviado concessionaria, aguardando vistoria, finalizado" },
  observacao: { type: "string", description: "Observações do andamento do projeto" },
};

const estoqueProperties = {
  id: idProperty("ID do item de estoque"),
  nome: { type: "string", description: "Nome do item, ex: Módulo Jinko 620W" },
  categoria: { type: "string", description: "Categoria, ex: módulo, inversor, cabo, conector, fixação" },
  unidade: { type: "string", description: "Unidade, ex: un, m, rolo, kit" },
  quantidade_atual: { type: "number", description: "Saldo atual" },
  estoque_minimo: { type: "number", description: "Quantidade mínima para alerta" },
  localizacao: { type: "string", description: "Local onde está armazenado" },
  observacao: { type: "string", description: "Observações do item" },
  ativo: { type: "boolean", description: "Se o item está ativo no estoque" },
};

const movimentacaoProperties = {
  produto_id: idProperty("ID do item de estoque"),
  tipo: { type: "string", description: "entrada, saida ou ajuste" },
  quantidade: { type: "number", description: "Quantidade movimentada. Em ajuste, vira o novo saldo." },
  motivo: { type: "string", description: "Motivo da movimentação" },
  responsavel: { type: "string", description: "Quem fez ou solicitou a movimentação" },
  projeto_id: idProperty("ID do projeto relacionado, se houver"),
  cliente: { type: "string", description: "Cliente relacionado, se houver" },
  observacao: { type: "string", description: "Observações adicionais" },
};

const recebimentoProperties = {
  id: idProperty("ID do recebimento"),
  cliente: { type: "string", description: "Nome de quem deve pagar" },
  valor: { type: "number", description: "Valor a receber em reais" },
  status: { type: "string", description: "Status: a receber, cobrado, parcial, recebido, atrasado, cancelado" },
  vencimento: { type: "string", description: "Data de vencimento no formato YYYY-MM-DD" },
  origem: { type: "string", description: "Origem da cobranca, ex: agenda, orcamento, projeto, servico" },
  agenda_id: idProperty("ID da agenda relacionada, se houver"),
  orcamento_id: idProperty("ID do orcamento relacionado, se houver"),
  projeto_id: idProperty("ID do projeto relacionado, se houver"),
  cobrado_em: { type: "string", description: "Data/hora em que a cobranca foi feita, em ISO, se houver" },
  recebido_em: { type: "string", description: "Data/hora em que recebeu, em ISO, se houver" },
  observacao: { type: "string", description: "Observacoes do recebimento" },
};
const tool = (name, description, properties = {}, required = []) => ({
  name,
  description,
  inputSchema: { type: "object", properties, required },
});

function withoutId(args) {
  const { id, ...payload } = args;
  return payload;
}

function setupMCPServer(server) {
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      tool("list_agenda", "Lista os compromissos da agenda do RapPanel"),
      tool("get_agenda", "Consulta um compromisso da agenda pelo ID", { id: agendaProperties.id }, ["id"]),
      tool("create_agenda", "Cadastra um novo compromisso na agenda do RapPanel", agendaProperties, ["titulo"]),
      tool("update_agenda", "Atualiza parcialmente um compromisso da agenda pelo ID", agendaProperties, ["id"]),
      tool("delete_agenda", "Exclui um compromisso da agenda pelo ID", { id: agendaProperties.id }, ["id"]),
      tool("list_orcamentos", "Lista todos os orçamentos cadastrados no RapPanel"),
      tool("get_orcamento", "Consulta um orçamento pelo ID, incluindo margem e detalhamento", { id: orcamentoProperties.id }, ["id"]),
      tool("create_orcamento", "Cadastra um novo orçamento solar no RapPanel", orcamentoProperties, ["cliente"]),
      tool("update_orcamento", "Atualiza parcialmente um orçamento pelo ID", orcamentoProperties, ["id"]),
      tool("delete_orcamento", "Exclui um orçamento pelo ID", { id: orcamentoProperties.id }, ["id"]),
      tool("list_projetos", "Lista todos os projetos fechados e finalizados"),
      tool("get_projeto", "Consulta um projeto pelo ID", { id: projetoProperties.id }, ["id"]),
      tool("create_projeto", "Cria um projeto manualmente, normalmente ligado a um orçamento", projetoProperties, ["cliente"]),
      tool("update_projeto", "Atualiza status ou observação de um projeto", projetoProperties, ["id"]),
      tool("delete_projeto", "Exclui um projeto pelo ID", { id: projetoProperties.id }, ["id"]),
      tool("fechar_orcamento_como_projeto", "Marca um orçamento como fechado e cria ou atualiza o projeto correspondente", {
        orcamento_id: orcamentoProperties.id,
        status: projetoProperties.status,
        observacao: projetoProperties.observacao,
      }, ["orcamento_id"]),
      tool("list_estoque", "Lista os itens ativos do estoque"),
      tool("get_item_estoque", "Consulta um item de estoque pelo ID", { id: estoqueProperties.id }, ["id"]),
      tool("create_item_estoque", "Cadastra um novo item no estoque", estoqueProperties, ["nome"]),
      tool("update_item_estoque", "Atualiza dados cadastrais de um item do estoque", estoqueProperties, ["id"]),
      tool("delete_item_estoque", "Inativa um item do estoque pelo ID", { id: estoqueProperties.id }, ["id"]),
      tool("movimentar_estoque", "Registra entrada, saída ou ajuste de saldo de um item do estoque", movimentacaoProperties, ["produto_id", "tipo", "quantidade"]),
      tool("list_movimentacoes_estoque", "Lista as últimas movimentações de estoque"),
      tool("list_recebimentos", "Lista cobrancas e valores a receber"),
      tool("get_recebimento", "Consulta uma cobranca pelo ID", { id: recebimentoProperties.id }, ["id"]),
      tool("create_recebimento", "Cria um valor a receber apos uma cobranca feita", recebimentoProperties, ["cliente", "valor"]),
      tool("update_recebimento", "Atualiza uma cobranca, incluindo status de recebimento", recebimentoProperties, ["id"]),
      tool("delete_recebimento", "Exclui um registro de recebimento pelo ID", { id: recebimentoProperties.id }, ["id"]),
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;

    try {
      if (name === "list_agenda") {
        const data = await apiRequest("/agenda");
        const lista = Array.isArray(data) ? data : [];
        const text = lista.length ? lista.map(formatAgenda).join("\n") : "Nenhum compromisso cadastrado.";
        return { content: [{ type: "text", text: `Agenda cadastrada (${lista.length}):\n\n${text}` }] };
      }

      if (name === "get_agenda") {
        const data = await apiRequest(`/agenda/${args.id}`);
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
      }

      if (name === "create_agenda") {
        const data = await apiRequest("/agenda", { method: "POST", body: JSON.stringify({ tipo: "venda", status: "agendado", ...withoutId(args) }) });
        return { content: [{ type: "text", text: `Compromisso cadastrado com sucesso.\n\n${formatAgenda(data)}` }] };
      }

      if (name === "update_agenda") {
        const data = await apiRequest(`/agenda/${args.id}`, { method: "PATCH", body: JSON.stringify(withoutId(args)) });
        return { content: [{ type: "text", text: `Compromisso atualizado com sucesso.\n\n${formatAgenda(data)}` }] };
      }

      if (name === "delete_agenda") {
        const data = await apiRequest(`/agenda/${args.id}`, { method: "DELETE" });
        return { content: [{ type: "text", text: `Compromisso excluído com sucesso. ID: ${data.id}` }] };
      }

      if (name === "list_orcamentos") {
        const data = await apiRequest("/orcamentos");
        const lista = Array.isArray(data) ? data : [];
        const text = lista.length ? lista.map(formatOrcamento).join("\n") : "Nenhum orçamento cadastrado.";
        return { content: [{ type: "text", text: `Orçamentos cadastrados (${lista.length}):\n\n${text}` }] };
      }

      if (name === "get_orcamento") {
        const data = await apiRequest(`/orcamentos/${args.id}`);
        return { content: [{ type: "text", text: `${formatOrcamento(data)}\n\nMargem:\nLucro: ${formatMoney(data.lucro)}\nLucro c/ desc. 5%: ${formatMoney(data.lucro_com_desconto_5)}\nMargem: ${data.margem_percentual || 0}%\n\nDetalhamento:\n${formatDetalhamento(data)}` }] };
      }

      if (name === "create_orcamento") {
        const data = await apiRequest("/orcamentos", { method: "POST", body: JSON.stringify({ status: "criado", ...withoutId(args) }) });
        return { content: [{ type: "text", text: `Orçamento cadastrado com sucesso.\n\n${formatOrcamento(data)}\n\nDetalhamento:\n${formatDetalhamento(data)}` }] };
      }

      if (name === "update_orcamento") {
        const data = await apiRequest(`/orcamentos/${args.id}`, { method: "PATCH", body: JSON.stringify(withoutId(args)) });
        return { content: [{ type: "text", text: `Orçamento atualizado com sucesso.\n\n${formatOrcamento(data)}` }] };
      }

      if (name === "delete_orcamento") {
        const data = await apiRequest(`/orcamentos/${args.id}`, { method: "DELETE" });
        return { content: [{ type: "text", text: `Orçamento excluído com sucesso. ID: ${data.id}` }] };
      }

      if (name === "list_projetos") {
        const data = await apiRequest("/projetos");
        const lista = Array.isArray(data) ? data : [];
        const text = lista.length ? lista.map(formatProjeto).join("\n") : "Nenhum projeto cadastrado.";
        return { content: [{ type: "text", text: `Projetos cadastrados (${lista.length}):\n\n${text}` }] };
      }

      if (name === "get_projeto") {
        const data = await apiRequest(`/projetos/${args.id}`);
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
      }

      if (name === "create_projeto") {
        const data = await apiRequest("/projetos", { method: "POST", body: JSON.stringify({ status: "aguardando documentação", ...withoutId(args) }) });
        return { content: [{ type: "text", text: `Projeto cadastrado com sucesso.\n\n${formatProjeto(data)}` }] };
      }

      if (name === "update_projeto") {
        const data = await apiRequest(`/projetos/${args.id}`, { method: "PATCH", body: JSON.stringify(withoutId(args)) });
        return { content: [{ type: "text", text: `Projeto atualizado com sucesso.\n\n${formatProjeto(data)}` }] };
      }

      if (name === "delete_projeto") {
        const data = await apiRequest(`/projetos/${args.id}`, { method: "DELETE" });
        return { content: [{ type: "text", text: `Projeto excluído com sucesso. ID: ${data.id}` }] };
      }

      if (name === "fechar_orcamento_como_projeto") {
        const payload = {
          status: args.status || "aguardando documentação",
          observacao: args.observacao || "Projeto criado a partir de orçamento fechado.",
        };
        const data = await apiRequest(`/orcamentos/${args.orcamento_id}/fechar`, { method: "POST", body: JSON.stringify(payload) });
        return { content: [{ type: "text", text: `Orçamento fechado e projeto criado/atualizado com sucesso.\n\n${formatProjeto(data)}` }] };
      }

      if (name === "list_estoque") {
        const data = await apiRequest("/estoque");
        const lista = Array.isArray(data) ? data : [];
        const text = lista.length ? lista.map(formatEstoque).join("\n") : "Nenhum item cadastrado no estoque.";
        return { content: [{ type: "text", text: `Estoque (${lista.length}):\n\n${text}` }] };
      }

      if (name === "get_item_estoque") {
        const data = await apiRequest(`/estoque/${args.id}`);
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
      }

      if (name === "create_item_estoque") {
        const data = await apiRequest("/estoque", { method: "POST", body: JSON.stringify({ unidade: "un", quantidade_atual: 0, estoque_minimo: 0, ativo: true, ...withoutId(args) }) });
        return { content: [{ type: "text", text: `Item cadastrado no estoque.\n\n${formatEstoque(data)}` }] };
      }

      if (name === "update_item_estoque") {
        const data = await apiRequest(`/estoque/${args.id}`, { method: "PATCH", body: JSON.stringify(withoutId(args)) });
        return { content: [{ type: "text", text: `Item atualizado no estoque.\n\n${formatEstoque(data)}` }] };
      }

      if (name === "delete_item_estoque") {
        const data = await apiRequest(`/estoque/${args.id}`, { method: "DELETE" });
        return { content: [{ type: "text", text: `Item inativado no estoque. ID: ${data.id}` }] };
      }

      if (name === "movimentar_estoque") {
        const { produto_id, ...payload } = args;
        const data = await apiRequest(`/estoque/${produto_id}/movimentar`, { method: "POST", body: JSON.stringify(payload) });
        return { content: [{ type: "text", text: `Movimentação registrada com sucesso.\n\n${formatEstoque(data.item)}\n${formatMovimentacao(data.movimentacao)}` }] };
      }

      if (name === "list_movimentacoes_estoque") {
        const data = await apiRequest("/estoque/movimentacoes");
        const lista = Array.isArray(data) ? data : [];
        const text = lista.length ? lista.map(formatMovimentacao).join("\n") : "Nenhuma movimentação de estoque registrada.";
        return { content: [{ type: "text", text: `Movimentações de estoque (${lista.length}):\n\n${text}` }] };
      }


      if (name === "list_recebimentos") {
        const data = await apiRequest("/recebimentos");
        const lista = Array.isArray(data) ? data : [];
        const text = lista.length ? lista.map(formatRecebimento).join("\n") : "Nenhum recebimento cadastrado.";
        const totalAberto = lista
          .filter((item) => !["recebido", "cancelado"].includes(String(item.status || "").toLowerCase()))
          .reduce((total, item) => total + Number(item.valor || 0), 0);
        return { content: [{ type: "text", text: `Recebimentos (${lista.length}) | aberto: ${formatMoney(totalAberto)}\n\n${text}` }] };
      }

      if (name === "get_recebimento") {
        const data = await apiRequest(`/recebimentos/${args.id}`);
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
      }

      if (name === "create_recebimento") {
        const data = await apiRequest("/recebimentos", { method: "POST", body: JSON.stringify({ status: "a receber", ...withoutId(args) }) });
        return { content: [{ type: "text", text: `Recebimento cadastrado com sucesso.\n\n${formatRecebimento(data)}` }] };
      }

      if (name === "update_recebimento") {
        const data = await apiRequest(`/recebimentos/${args.id}`, { method: "PATCH", body: JSON.stringify(withoutId(args)) });
        return { content: [{ type: "text", text: `Recebimento atualizado com sucesso.\n\n${formatRecebimento(data)}` }] };
      }

      if (name === "delete_recebimento") {
        const data = await apiRequest(`/recebimentos/${args.id}`, { method: "DELETE" });
        return { content: [{ type: "text", text: `Recebimento excluido com sucesso. ID: ${data.id}` }] };
      }
      return {
        content: [{ type: "text", text: `Ferramenta desconhecida: ${name}` }],
        isError: true,
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Erro ao executar ${name}: ${error.message}` }],
        isError: true,
      };
    }
  });
}

app.get("/sse", async (req, res) => {
  const connectionId = randomUUID();

  const server = new Server(
    { name: "rappanel-mcp", version: "1.4.0" },
    { capabilities: { tools: {} } }
  );

  setupMCPServer(server);

  const transport = new SSEServerTransport(`/message/${connectionId}`, res);
  activeConnections.set(connectionId, { server, transport });

  res.on("close", () => {
    activeConnections.delete(connectionId);
  });

  try {
    await server.connect(transport);
  } catch (error) {
    console.error("Erro ao conectar MCP:", error);
    activeConnections.delete(connectionId);
  }
});

app.post("/message/:connectionId", async (req, res) => {
  const connection = activeConnections.get(req.params.connectionId);

  if (!connection) {
    return res.status(404).json({ error: "Connection not found" });
  }

  await connection.transport.handlePostMessage(req, res, req.body);
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "MCP RapPanel",
    version: "1.4.0",
    connections: activeConnections.size,
    tools: [
      "list_agenda",
      "get_agenda",
      "create_agenda",
      "update_agenda",
      "delete_agenda",
      "list_orcamentos",
      "get_orcamento",
      "create_orcamento",
      "update_orcamento",
      "delete_orcamento",
      "list_projetos",
      "get_projeto",
      "create_projeto",
      "update_projeto",
      "delete_projeto",
      "fechar_orcamento_como_projeto",
      "list_estoque",
      "get_item_estoque",
      "create_item_estoque",
      "update_item_estoque",
      "delete_item_estoque",
      "movimentar_estoque",
      "list_movimentacoes_estoque",
      "list_recebimentos",
      "get_recebimento",
      "create_recebimento",
      "update_recebimento",
      "delete_recebimento",
    ],
  });
});

app.listen(PORT, () => {
  console.log(`MCP RapPanel rodando em http://localhost:${PORT}`);
  console.log(`SSE: http://localhost:${PORT}/sse`);
});
