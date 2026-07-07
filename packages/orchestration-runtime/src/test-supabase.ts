export type TestSupabaseRow = Record<string, unknown>;

export interface TestSupabaseStore {
  [table: string]: TestSupabaseRow[];
  user_roles: TestSupabaseRow[];
  conversations: TestSupabaseRow[];
  messages: TestSupabaseRow[];
  openclaw_task_jobs: TestSupabaseRow[];
  memory_entities: TestSupabaseRow[];
  memory_relations: TestSupabaseRow[];
  message_feedback: TestSupabaseRow[];
  agent_templates: TestSupabaseRow[];
  agent_template_versions: TestSupabaseRow[];
  general_orchestration_daemon_drafts: TestSupabaseRow[];
  general_orchestration_daemon_published_demos: TestSupabaseRow[];
  policy_canvases: TestSupabaseRow[];
  state_policy_canvases: TestSupabaseRow[];
  canvas_execution_plans: TestSupabaseRow[];
}

export interface TestSupabasePersonaSeed {
  userUUID: string;
  email: string;
  role: string;
  expertDemos: readonly string[];
}

export interface DefaultTestSupabasePersonas {
  admin: TestSupabasePersonaSeed;
  "expert-all": TestSupabasePersonaSeed;
  user: TestSupabasePersonaSeed;
  [persona: string]: TestSupabasePersonaSeed;
}

export interface CreateDefaultTestSupabaseStoreOptions {
  personas: DefaultTestSupabasePersonas;
  conversations?: TestSupabaseRow[];
}

type Filter = { col: string; op: "eq" | "is"; val: unknown };

export function createDefaultTestSupabaseStore(
  options: CreateDefaultTestSupabaseStoreOptions
): TestSupabaseStore {
  const { personas } = options;
  return {
    user_roles: Object.values(personas).map((persona) => ({
      user_id: persona.userUUID,
      email: persona.email,
      role: persona.role,
      expert_demos: persona.expertDemos,
    })),
    conversations:
      options.conversations ??
      [
        {
          id: "conv-admin-nutrition-1",
          user_id: personas.admin.userUUID,
          topic: "nutrition",
          title: "Admin nutrition chat",
          updated_at: "2026-01-01T00:00:00Z",
        },
        {
          id: "conv-user-nutrition-1",
          user_id: personas.user.userUUID,
          topic: "nutrition",
          title: "User-only nutrition chat",
          updated_at: "2026-01-02T00:00:00Z",
        },
        {
          id: "conv-expert-sleep-1",
          user_id: personas["expert-all"].userUUID,
          topic: "sleep",
          title: "Expert sleep chat",
          updated_at: "2026-01-03T00:00:00Z",
        },
        {
          id: "conv-expert-research-1",
          user_id: personas["expert-all"].userUUID,
          topic: "research-assistant",
          title: "Expert research assistant chat",
          updated_at: "2026-01-04T00:00:00Z",
        },
      ],
    messages: [],
    openclaw_task_jobs: [],
    memory_entities: [],
    memory_relations: [],
    message_feedback: [],
    agent_templates: [],
    agent_template_versions: [],
    general_orchestration_daemon_drafts: [],
    general_orchestration_daemon_published_demos: [],
    policy_canvases: [],
    state_policy_canvases: [],
    canvas_execution_plans: [],
  };
}

class QueryBuilder {
  private filters: Filter[] = [];
  private selectCols: string | null = null;
  private orderCol: string | null = null;
  private orderAsc = true;
  private mode: "select" | "insert" | "update" | "delete" = "select";
  private payload: TestSupabaseRow | TestSupabaseRow[] | null = null;
  private singleMode: "single" | "maybeSingle" | null = null;

  constructor(
    private table: string,
    private getStore: () => TestSupabaseStore
  ) {}

  select(cols?: string) {
    this.selectCols = cols ?? "*";
    return this;
  }

  insert(payload: TestSupabaseRow | TestSupabaseRow[]) {
    this.mode = "insert";
    this.payload = payload;
    return this;
  }

  update(payload: TestSupabaseRow) {
    this.mode = "update";
    this.payload = payload;
    return this;
  }

  upsert(payload: TestSupabaseRow) {
    this.mode = "insert";
    this.payload = payload;
    return this;
  }

  delete() {
    this.mode = "delete";
    return this;
  }

  eq(col: string, val: unknown) {
    this.filters.push({ col, op: "eq", val });
    return this;
  }

  is(col: string, val: unknown) {
    this.filters.push({ col, op: "is", val });
    return this;
  }

  in(col: string, vals: unknown[]) {
    this.filters.push({ col, op: "eq", val: vals });
    return this;
  }

  order(col: string, opts?: { ascending?: boolean; nullsFirst?: boolean }) {
    this.orderCol = col;
    this.orderAsc = opts?.ascending ?? true;
    return this;
  }

  single() {
    this.singleMode = "single";
    return this.run();
  }

  maybeSingle() {
    this.singleMode = "maybeSingle";
    return this.run();
  }

  then<T>(
    onfulfilled: (value: {
      data: unknown;
      error: { message: string } | null;
    }) => T
  ) {
    return Promise.resolve(this.run()).then(onfulfilled);
  }

  private getTable(): TestSupabaseRow[] {
    const store = this.getStore();
    store[this.table] ??= [];
    return store[this.table];
  }

  private matches(row: TestSupabaseRow): boolean {
    for (const filter of this.filters) {
      const cell = row[filter.col];
      if (filter.op === "is") {
        if (filter.val === null && cell != null) return false;
        if (filter.val !== null && cell !== filter.val) return false;
      } else if (filter.op === "eq") {
        if (Array.isArray(filter.val)) {
          if (!filter.val.includes(cell)) return false;
        } else if (cell !== filter.val) {
          return false;
        }
      }
    }
    return true;
  }

  private run(): { data: unknown; error: { message: string } | null } {
    const table = this.getTable();
    if (this.mode === "insert") {
      const rows = Array.isArray(this.payload) ? this.payload : [this.payload!];
      const inserted: TestSupabaseRow[] = [];
      for (const row of rows) {
        const keys = this.table === "user_roles" ? ["user_id"] : ["id"];
        const hasKeys = keys.every((key) => row[key] != null);
        const existingIdx = hasKeys
          ? table.findIndex((existing) =>
              keys.every((key) => existing[key] === row[key])
            )
          : -1;
        if (existingIdx >= 0) {
          table[existingIdx] = { ...table[existingIdx], ...row };
          inserted.push(table[existingIdx]);
        } else {
          const withId =
            keys.includes("id") && row.id == null
              ? {
                  ...row,
                  id: `gen-${Date.now()}-${Math.random()
                    .toString(36)
                    .slice(2, 8)}`,
                }
              : row;
          table.push(withId);
          inserted.push(withId);
        }
      }
      const data =
        this.singleMode === "single" || this.singleMode === "maybeSingle"
          ? inserted[0] ?? null
          : inserted;
      return { data, error: null };
    }

    if (this.mode === "update") {
      const updated: TestSupabaseRow[] = [];
      for (const row of table) {
        if (this.matches(row)) {
          Object.assign(row, this.payload as TestSupabaseRow);
          updated.push(row);
        }
      }
      const data =
        this.singleMode === "single" || this.singleMode === "maybeSingle"
          ? updated[0] ?? null
          : updated;
      return { data, error: null };
    }

    if (this.mode === "delete") {
      let index = table.length;
      while (index--) {
        if (this.matches(table[index])) table.splice(index, 1);
      }
      return { data: null, error: null };
    }

    let rows = table.filter((row) => this.matches(row));
    if (this.orderCol) {
      const col = this.orderCol;
      const asc = this.orderAsc;
      rows = [...rows].sort((a, b) => {
        const av = a[col];
        const bv = b[col];
        if (av == null && bv == null) return 0;
        if (av == null) return 1;
        if (bv == null) return -1;
        if (av < bv) return asc ? -1 : 1;
        if (av > bv) return asc ? 1 : -1;
        return 0;
      });
    }
    const data =
      this.singleMode === "single"
        ? rows[0] ?? null
        : this.singleMode === "maybeSingle"
        ? rows[0] ?? null
        : rows;
    return { data, error: null };
  }
}

export function createMemorySupabaseClient(
  getStore: () => TestSupabaseStore
) {
  return {
    from(table: string) {
      return new QueryBuilder(table, getStore);
    },
  };
}
