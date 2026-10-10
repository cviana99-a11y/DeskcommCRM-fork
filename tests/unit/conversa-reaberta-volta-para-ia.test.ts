import { describe, expect, it } from "vitest";

import {
  atendimentoConfigPatchSchema,
  conversaReabertaVoltaParaIA,
  mesclarSettingsDeAtendimento,
  routingConfigSchema,
} from "@/lib/schemas/routing";
import { RECURSOS_OPCIONAIS } from "@/lib/recursos-opcionais/catalogo";

/**
 * "A conversa encerrada volta para a IA": ajuste por empresa, DESLIGADO por
 * padrão. O banco (`fn_service_inbound`, migration 0629) lê o mesmo caminho com
 * a mesma régua — só o booleano `true` liga.
 */
describe("conversaReabertaVoltaParaIA", () => {
  it.each([
    ["settings ausente", null],
    ["settings sem routing", {}],
    ["routing sem a chave", { routing: { mode: "manual" } }],
    ["false", { routing: { reopened_conversation_goes_to_ai: false } }],
    ["texto \"true\"", { routing: { reopened_conversation_goes_to_ai: "true" } }],
    ["1", { routing: { reopened_conversation_goes_to_ai: 1 } }],
  ])("desligado com %s", (_nome, settings) => {
    expect(conversaReabertaVoltaParaIA(settings)).toBe(false);
  });

  it("liga só com o booleano true em settings.routing", () => {
    expect(
      conversaReabertaVoltaParaIA({ routing: { reopened_conversation_goes_to_ai: true } }),
    ).toBe(true);
  });

  it("o padrão do schema é desligado", () => {
    expect(routingConfigSchema.parse({}).reopened_conversation_goes_to_ai).toBe(false);
  });
});

describe("mesclarSettingsDeAtendimento preserva o ajuste", () => {
  const ligado = { routing: { ...routingConfigSchema.parse({}), reopened_conversation_goes_to_ai: true } };

  it("cliente antigo que não manda a chave não desliga o ajuste por omissão", () => {
    const { settings } = mesclarSettingsDeAtendimento(
      ligado,
      atendimentoConfigPatchSchema.parse({ mode: "load" }),
    );
    expect(conversaReabertaVoltaParaIA(settings)).toBe(true);
  });

  it("mandar false desliga, mandar true liga", () => {
    const off = mesclarSettingsDeAtendimento(
      ligado,
      atendimentoConfigPatchSchema.parse({ mode: "manual", reopened_conversation_goes_to_ai: false }),
    );
    expect(conversaReabertaVoltaParaIA(off.settings)).toBe(false);
    const on = mesclarSettingsDeAtendimento(
      {},
      atendimentoConfigPatchSchema.parse({ mode: "manual", reopened_conversation_goes_to_ai: true }),
    );
    expect(conversaReabertaVoltaParaIA(on.settings)).toBe(true);
  });

  it("não mexe no ajuste vizinho 'a conversa fica com quem atendeu'", () => {
    const { routing } = mesclarSettingsDeAtendimento(
      { routing: { ...routingConfigSchema.parse({}), conversation_stays_with_attendant: true } },
      atendimentoConfigPatchSchema.parse({ mode: "manual", reopened_conversation_goes_to_ai: true }),
    );
    expect(routing.conversation_stays_with_attendant).toBe(true);
    expect(routing.reopened_conversation_goes_to_ai).toBe(true);
  });
});

describe("o recurso aparece na lista de recursos opcionais", () => {
  const recurso = RECURSOS_OPCIONAIS.find((r) => r.id === "conversa_reaberta_volta_para_ia");

  it("aponta para a tela que liga e lê o estado pelo settings", () => {
    expect(recurso?.href).toBe("/app/settings/atendimento");
    expect(recurso?.padrao).toBe("desligado");
    const ler = recurso?.ler;
    expect(ler?.({ modulos: [], servidor: {}, settings: {} })).toBe("desligado");
    expect(
      ler?.({ modulos: [], servidor: {}, settings: { routing: { reopened_conversation_goes_to_ai: true } } }),
    ).toBe("ligado");
  });
});
