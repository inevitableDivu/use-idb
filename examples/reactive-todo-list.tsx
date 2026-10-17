import { createDatabase, createDatabaseHooks, store } from "@inevitable_divu/use-idb";

interface Todo {
  id: string;
  title: string;
  done: boolean;
  createdAt: Date;
}

const db = createDatabase({
  name: "use-idb-example-todos",
  version: 1,
  stores: {
    todos: store<Todo>()({
      keyPath: "id",
      indexes: {
        by_done: "done",
        by_created: "createdAt",
      },
    }),
  },
});

const { useLiveQuery, useMutation } = createDatabaseHooks(db);

export function ReactiveTodoList() {
  const {
    data: todos = [],
    isLoading,
    error,
  } = useLiveQuery(
    (database) =>
      database.query("todos").where("done").equals(false).orderBy("createdAt", "desc").toArray(),
    [],
  );
  const { put, deleteRecord, isPending } = useMutation("todos");

  async function addTodo() {
    await put({
      id: crypto.randomUUID(),
      title: "Review local changes",
      done: false,
      createdAt: new Date(),
    });
  }

  if (error) return <p role="alert">{error.message}</p>;
  if (isLoading) return <p>Loading todos…</p>;

  return (
    <section>
      <button disabled={isPending} onClick={() => void addTodo()}>
        Add todo
      </button>
      <ul>
        {todos.map((todo) => (
          <li key={todo.id}>
            {todo.title}
            <button
              aria-label={`Remove ${todo.title}`}
              disabled={isPending}
              onClick={() => void deleteRecord(todo.id)}
            >
              Remove
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
