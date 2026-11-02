const list = document.getElementById("todo-list");
const form = document.getElementById("add-form");
const input = document.getElementById("new-todo");
const empty = document.getElementById("empty");

// 4 Elysia API workers share one port (reusePort) and the same todo store.
const API_PORT = 3001;

function apiUrl(path) {
  return `http://localhost:${API_PORT}${path}`;
}

async function request(path, options = {}) {
  const url = apiUrl(path);
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `Request failed: ${res.status}`);
  }
  return res.status === 204 ? null : res.json();
}

function render(todos) {
  list.innerHTML = "";
  empty.hidden = todos.length > 0;

  for (const todo of todos) {
    const li = document.createElement("li");
    li.className = "todo-item" + (todo.done ? " done" : "");
    li.dataset.id = todo.id;

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = todo.done;
    checkbox.addEventListener("change", () =>
      toggle(todo.id, checkbox.checked),
    );

    const title = document.createElement("span");
    title.className = "title";
    title.textContent = todo.title;

    const del = document.createElement("button");
    del.className = "delete";
    del.textContent = "✕";
    del.title = "Löschen";
    del.addEventListener("click", () => remove(todo.id));

    li.append(checkbox, title, del);
    list.appendChild(li);
  }
}

async function load() {
  render(await request("/api/todos"));
}

async function add(title) {
  const todo = await request("/api/todos", {
    method: "POST",
    body: JSON.stringify({ title }),
  });
  const todos = await request("/api/todos");
  render(todos);
  return todo;
}

async function toggle(id, done) {
  await request(`/api/todos/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ done }),
  });
}

async function remove(id) {
  await request(`/api/todos/${id}`, { method: "DELETE" });
  const todos = await request("/api/todos");
  render(todos);
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const title = input.value.trim();
  if (!title) return;
  input.value = "";
  try {
    await add(title);
  } catch (err) {
    alert(err.message);
  }
});

load();
