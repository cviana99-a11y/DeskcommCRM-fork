import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GOV_AGENT_A, GOV_ORG, GOV_SESSION, seedGov } from "./gov-helpers";

const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 3,
});

beforeAll(() => seedGov());
afterAll(async () => pool.end());

type Chave = "reopened_conversation_goes_to_ai" | "conversation_stays_with_attendant";

/**
 * Os ajustes por empresa gravados no MESMO caminho que a tela grava
 * (`settings.routing`). O valor é jsonb cru de propósito: o banco só liga com o
 * booleano `true`.
 */
async function ajuste(chave: Chave, valor: "true" | "false" | '"true"' | null) {
  await pool.query(
    `update organizations
        set settings = case
          when $3::jsonb is null then coalesce(settings, '{}'::jsonb) #- array['routing', $2::text]
          else jsonb_set(coalesce(settings, '{}'::jsonb), '{routing}',
                 coalesce(settings->'routing', '{}'::jsonb) || jsonb_build_object($2::text, $3::jsonb))
        end
      where id = $1`,
    [GOV_ORG, chave, valor],
  );
}

/**
 * Uma conversa que PASSOU POR UMA PESSOA e foi encerrada: as duas travas da
 * passagem de pé (silêncio da conversa e só-humano do contato), como o motor as
 * deixa (`performHumanHandoff`), e `last_handoff_at` preenchido — que é o que
 * faz o encerramento conservar o silêncio.
 */
async function encerradaDepoisDaPassagem(owner: string | null) {
  const contact = randomUUID();
  const conversation = randomUUID();
  await pool.query(
    "insert into contacts(id,organization_id,display_name,force_human) values($1,$2,'Reabertura IA',true)",
    [contact, GOV_ORG],
  );
  await pool.query(
    `insert into conversations(id,organization_id,contact_id,channel_session_id,status,
                               bot_silenced_until,last_handoff_at)
     values($1,$2,$3,$4,'open','infinity',clock_timestamp())`,
    [conversation, GOV_ORG, contact, GOV_SESSION],
  );
  if (owner) {
    const claim = await pool.query(
      "select id from fn_conversation_assign($1,$2,$3,'claim',null,true)",
      [GOV_ORG, conversation, owner],
    );
    expect(claim.rows).toHaveLength(1);
  }
  await pool.query("select * from fn_service_status($1,$2,'closed',null)", [GOV_ORG, conversation]);
  return { contact, conversation };
}

async function receive(contact: string, conversation: string) {
  await pool.query(
    `insert into messages
      (id,organization_id,conversation_id,channel_session_id,contact_id,type,direction,status,sent_via,body,sent_at)
     values($1,$2,$3,$4,$5,'text','inbound','received','ai','Voltei',clock_timestamp())`,
    [randomUUID(), GOV_ORG, conversation, GOV_SESSION, contact],
  );
}

async function estado(contact: string, conversation: string) {
  return (
    await pool.query(
      `select c.status,c.assigned_to_user_id,c.assignee_kind,
              c.bot_silenced_until::text bot_silenced_until,
              k.force_human,d.dono_kind
         from conversations c
         join contacts k on k.id=c.contact_id
         left join demandas d on d.id=c.current_demanda_id
        where c.id=$1 and c.organization_id=$2 and k.id=$3`,
      [conversation, GOV_ORG, contact],
    )
  ).rows[0];
}

describe("conversa encerrada depois de passar por uma pessoa, com o ajuste LIGADO", () => {
  beforeAll(() => ajuste("reopened_conversation_goes_to_ai", "true"));
  afterAll(() => ajuste("reopened_conversation_goes_to_ai", null));

  it("o encerramento ainda conserva as travas (a precondição do defeito)", async () => {
    const { contact, conversation } = await encerradaDepoisDaPassagem(null);
    expect(await estado(contact, conversation)).toMatchObject({
      status: "closed",
      bot_silenced_until: "infinity",
      force_human: true,
    });
  });

  it.each([
    ["sem responsável", null],
    ["com o responsável que atendeu", GOV_AGENT_A],
  ] as const)("a mensagem nova reabre com a IA atendendo (%s)", async (_nome, owner) => {
    const { contact, conversation } = await encerradaDepoisDaPassagem(owner);
    await receive(contact, conversation);
    expect(await estado(contact, conversation)).toMatchObject({
      status: "open",
      assigned_to_user_id: null,
      assignee_kind: null,
      bot_silenced_until: null,
      force_human: false,
      dono_kind: "ia",
    });
  });

  it("'a conversa fica com quem atendeu' vence quando o atendente ainda é da equipe", async () => {
    await ajuste("conversation_stays_with_attendant", "true");
    try {
      const { contact, conversation } = await encerradaDepoisDaPassagem(GOV_AGENT_A);
      await receive(contact, conversation);
      expect(await estado(contact, conversation)).toMatchObject({
        status: "claimed",
        assigned_to_user_id: GOV_AGENT_A,
        assignee_kind: "user",
        bot_silenced_until: "infinity",
        force_human: true,
        dono_kind: "humano",
      });
    } finally {
      await ajuste("conversation_stays_with_attendant", null);
    }
  });
});

/**
 * O PADRÃO — e o de toda empresa que já existia antes da 0629: as travas da
 * passagem sobrevivem à reabertura, exatamente como na 0396.
 */
describe("conversa encerrada depois de passar por uma pessoa, com o ajuste DESLIGADO", () => {
  it.each([
    ["ausente", null],
    ["false", "false"],
    ["texto \"true\" (não é booleano)", '"true"'],
  ] as const)("reabre na fila com a IA calada, ajuste %s", async (_nome, valor) => {
    await ajuste("reopened_conversation_goes_to_ai", valor);
    try {
      const { contact, conversation } = await encerradaDepoisDaPassagem(null);
      await receive(contact, conversation);
      expect(await estado(contact, conversation)).toMatchObject({
        status: "open",
        assignee_kind: null,
        bot_silenced_until: "infinity",
        force_human: true,
      });
    } finally {
      await ajuste("reopened_conversation_goes_to_ai", null);
    }
  });
});
