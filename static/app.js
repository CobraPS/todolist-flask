(() => {
  // Main UI elements
  const listEl = document.getElementById("list");
  const dayListEl = document.getElementById("dayList");
  const undatedListEl = document.getElementById("undatedList");

  const textEl = document.getElementById("text");
  const dueDateEl = document.getElementById("dueDate");
  const priorityEl = document.getElementById("priority");
  const formEl = document.getElementById("createForm");

  const searchEl = document.getElementById("search");

  const errEl = document.getElementById("error");
  const countEl = document.getElementById("count");
  const clearDoneBtn = document.getElementById("clearDone");

  const overallProgressEl = document.getElementById("overallProgress");
  const toastHostEl = document.getElementById("toastHost");

  const themeSelect = document.getElementById("themeSelect");

  const viewListBtn = document.getElementById("viewListBtn");
  const viewCalBtn = document.getElementById("viewCalBtn");
  const listView = document.getElementById("listView");
  const calView = document.getElementById("calView");

  const calTitleEl = document.getElementById("calTitle");
  const calGridEl = document.getElementById("calGrid");
  const prevMonthBtn = document.getElementById("prevMonth");
  const nextMonthBtn = document.getElementById("nextMonth");
  const todayBtn = document.getElementById("todayBtn");
  const dayTitleEl = document.getElementById("dayTitle");
  const daySubtitleEl = document.getElementById("daySubtitle");

  // Modal elements (edit task)
  const modalBackdrop = document.getElementById("modalBackdrop");
  const modalTitleEl = document.getElementById("modalTitle");
  const modalSubtitleEl = document.getElementById("modalSubtitle");
  const modalCloseBtn = document.getElementById("modalClose");
  const modalTextEl = document.getElementById("modalText");
  const modalDueEl = document.getElementById("modalDue");
  const modalPriorityEl = document.getElementById("modalPriority");
  const modalRecurUnitEl = document.getElementById("modalRecurUnit");
  const modalRecurIntervalEl = document.getElementById("modalRecurInterval");
  const modalErrorEl = document.getElementById("modalError");
  const cancelBtn = document.getElementById("cancelBtn");
  const saveBtn = document.getElementById("saveBtn");

  const Theme = window.Theme || {
    applyTheme: () => {},
    getStoredTheme: () => "system",
    setStoredTheme: () => {},
  };

  // Theme init
  themeSelect.value = Theme.getStoredTheme();
  themeSelect.addEventListener("change", () => {
    const mode = themeSelect.value;
    Theme.setStoredTheme(mode);
    Theme.applyTheme(mode);
  });

  function showError(msg) {
    errEl.textContent = msg;
    errEl.hidden = !msg;
  }

  function showModalError(msg) {
    modalErrorEl.textContent = msg;
    modalErrorEl.hidden = !msg;
  }

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      headers: { "Content-Type": "application/json" },
      ...opts,
    });
    if (res.status === 204) return null;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  // App state
  let todos = [];
  let currentView = "list";
  let editingId = null;
  let selectedId = null;
  let searchTerm = "";

  // Toast / undo state
  const UNDO_MS = 5000;
  const undoTimers = new Map(); // todoId -> timeoutId

  // Calendar state
  const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  let calMonth = new Date();
  let selectedDate = toYMD(new Date());

  function toYMD(d) {
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  }

  function todayYMD() {
    return toYMD(new Date());
  }

  function fromYMD(ymd) {
    const [y, m, d] = ymd.split("-").map(Number);
    return new Date(y, m - 1, d);
  }

  function fmtMonthTitle(d) {
    return d.toLocaleString(undefined, { month: "long", year: "numeric" });
  }

  // Default due date for new root tasks
  dueDateEl.value = todayYMD();

  function clamp01(x) {
    return Math.max(0, Math.min(1, x));
  }

  // Red (0%) -> Green (100%)
  function ratioToColor(r) {
    const rr = clamp01(r);
    const hue = 120 * rr; // 0=red, 120=green
    return `hsl(${hue} 70% 45%)`;
  }

  function setProgressBar(el, ratio) {
    if (!el) return;
    const r = clamp01(ratio);
    el.style.width = `${Math.round(r * 100)}%`;
    el.style.backgroundColor = ratioToColor(r);
    el.parentElement?.setAttribute("title", `${Math.round(r * 100)}% complete`);
  }

  function setView(v) {
    currentView = v;
    if (v === "list") {
      listView.classList.add("active");
      calView.classList.remove("active");
      viewListBtn.classList.add("active");
      viewCalBtn.classList.remove("active");
      viewListBtn.setAttribute("aria-selected", "true");
      viewCalBtn.setAttribute("aria-selected", "false");
    } else {
      calView.classList.add("active");
      listView.classList.remove("active");
      viewCalBtn.classList.add("active");
      viewListBtn.classList.remove("active");
      viewCalBtn.setAttribute("aria-selected", "true");
      viewListBtn.setAttribute("aria-selected", "false");
    }
    renderAll();
  }

  viewListBtn.addEventListener("click", () => setView("list"));
  viewCalBtn.addEventListener("click", () => setView("calendar"));

  searchEl.addEventListener("input", () => {
    searchTerm = (searchEl.value || "").trim().toLowerCase();
    renderAll();
  });

  function stats(items) {
    const total = items.length;
    const doneCount = items.filter((t) => t.done).length;
    countEl.textContent = `${doneCount}/${total} done`;
    setProgressBar(overallProgressEl, total ? doneCount / total : 0);
  }

  // Sorting: incomplete first, complete last, then priority desc, then due_date asc (undated last), then id desc
  function sortForTree(items) {
    return [...items].sort((a, b) => {
      if (a.done !== b.done) return a.done - b.done;

      const ap = Number.isInteger(a.priority) ? a.priority : 1;
      const bp = Number.isInteger(b.priority) ? b.priority : 1;
      if (ap !== bp) return bp - ap; // higher priority first

      const ad = a.due_date || "9999-99-99";
      const bd = b.due_date || "9999-99-99";
      if (ad < bd) return -1;
      if (ad > bd) return 1;

      return b.id - a.id;
    });
  }

  // Expanded set; default collapsed (search forces expand)
  const EXPANDED_KEY = "todo_expanded_ids_v1";
  function loadExpanded() {
    try {
      const raw = localStorage.getItem(EXPANDED_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(arr)) return new Set();
      const ints = arr
        .map((x) => (Number.isInteger(x) ? x : parseInt(String(x), 10)))
        .filter((x) => Number.isInteger(x) && x > 0);
      return new Set(ints);
    } catch {
      return new Set();
    }
  }
  function saveExpanded(set) {
    localStorage.setItem(EXPANDED_KEY, JSON.stringify([...set]));
  }
  const expanded = loadExpanded();

  function isExpanded(id) {
    if (searchTerm) return true; // show matches without requiring manual expansion
    return expanded.has(id);
  }
  function toggleExpanded(id) {
    if (expanded.has(id)) expanded.delete(id);
    else expanded.add(id);
    saveExpanded(expanded);
  }
  function ensureExpanded(id) {
    if (!expanded.has(id)) {
      expanded.add(id);
      saveExpanded(expanded);
    }
  }

  function monthRangeGrid(monthDate) {
    const firstOfMonth = new Date(monthDate.getFullYear(), monthDate.getMonth(), 1);
    const start = new Date(firstOfMonth);
    start.setDate(start.getDate() - start.getDay());
    const days = [];
    for (let i = 0; i < 42; i++) {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      days.push(d);
    }
    return days;
  }

  function countByDueDate(items) {
    const map = new Map(); // ymd -> { total, done }
    for (const t of items) {
      if (!t.due_date) continue;
      const k = t.due_date;
      const v = map.get(k) || { total: 0, done: 0 };
      v.total += 1;
      if (t.done) v.done += 1;
      map.set(k, v);
    }
    return map;
  }

  function forestFromItems(items) {
    const byId = new Map();
    const children = new Map();

    for (const t of items) {
      byId.set(t.id, t);
      children.set(t.id, []);
    }

    for (const t of items) {
      const pid = t.parent_id;
      if (pid != null && byId.has(pid)) {
        children.get(pid).push(t);
      }
    }

    for (const [id, arr] of children.entries()) {
      children.set(id, sortForTree(arr));
    }

    const roots = [];
    for (const t of items) {
      const pid = t.parent_id;
      if (pid == null || !byId.has(pid)) roots.push(t);
    }

    return { roots: sortForTree(roots), children, byId };
  }

  function applySearchFilter(items) {
    if (!searchTerm) return items;

    // Include matches + their ancestors so the tree remains coherent.
    const byId = new Map(items.map((t) => [t.id, t]));
    const include = new Set();

    for (const t of items) {
      const txt = (t.text || "").toLowerCase();
      if (txt.includes(searchTerm)) {
        include.add(t.id);
        let cur = t;
        while (cur && cur.parent_id != null && byId.has(cur.parent_id)) {
          include.add(cur.parent_id);
          cur = byId.get(cur.parent_id);
        }
      }
    }

    return items.filter((t) => include.has(t.id));
  }

  function priorityLabel(p) {
    switch (Number(p)) {
      case 0: return "Low";
      case 1: return "Normal";
      case 2: return "High";
      case 3: return "Critical";
      default: return "Normal";
    }
  }

  function dueClass(t) {
    if (t.done) return "";
    if (!t.due_date) return "";
    const today = todayYMD();
    if (t.due_date < today) return "overdue";
    if (t.due_date === today) return "due-today";
    return "";
  }

  // ---- Toast undo ----
  function showUndoToast({ message, onUndo }) {
    const toast = document.createElement("div");
    toast.className = "toast";

    const msg = document.createElement("div");
    msg.className = "msg";
    msg.textContent = message;

    const undo = document.createElement("button");
    undo.type = "button";
    undo.className = "undo";
    undo.textContent = "Undo";

    undo.addEventListener("click", () => {
      onUndo();
      toast.remove();
    });

    toast.appendChild(msg);
    toast.appendChild(undo);
    toastHostEl.appendChild(toast);

    const tid = setTimeout(() => {
      toast.remove();
    }, UNDO_MS);

    return tid;
  }

  async function softDeleteTodo(id) {
    try {
      showError("");
      // Immediate soft-delete in backend (persisted), so refresh won’t “undo” it.
      await api(`/api/todos/${id}`, { method: "DELETE" });
      await load();

      // After load, offer undo
      const timerId = showUndoToast({
        message: "Task deleted",
        onUndo: async () => {
          const t = undoTimers.get(id);
          if (t) {
            clearTimeout(t);
            undoTimers.delete(id);
          }
          try {
            await api(`/api/todos/${id}`, {
              method: "PATCH",
              body: JSON.stringify({ deleted: false }),
            });
            await load();
          } catch (e) {
            showError(e.message);
          }
        },
      });

      undoTimers.set(id, timerId);

      // If user never clicks Undo, toast disappears after UNDO_MS; deletion remains.
      setTimeout(() => {
        const t = undoTimers.get(id);
        if (t) undoTimers.delete(id);
      }, UNDO_MS + 50);

      // If deleted selected task, clear selection
      if (selectedId === id) selectedId = null;
    } catch (e) {
      showError(e.message);
    }
  }

  // ---- Modal ----
  modalRecurUnitEl.addEventListener("change", () => {
    modalRecurIntervalEl.disabled = modalRecurUnitEl.value === "none";
  });

  function openModalForTodo(todoId) {
    const t = todos.find((x) => x.id === todoId);
    if (!t) return;

    editingId = todoId;
    modalTitleEl.textContent = "Edit task";
    modalSubtitleEl.textContent = `ID ${t.id}` + (t.parent_id ? ` · parent ${t.parent_id}` : "");

    modalTextEl.value = t.text || "";
    modalDueEl.value = t.due_date || "";

    modalPriorityEl.value = String(Number.isInteger(t.priority) ? t.priority : 1);

    const unit = t.recurrence_unit || "none";
    modalRecurUnitEl.value = unit;
    modalRecurIntervalEl.value = t.recurrence_interval || 1;
    modalRecurIntervalEl.disabled = unit === "none";

    showModalError("");

    modalBackdrop.classList.remove("hidden");
    modalBackdrop.setAttribute("aria-hidden", "false");
    setTimeout(() => modalTextEl.focus(), 0);
  }

  function closeModal() {
    editingId = null;
    modalBackdrop.classList.add("hidden");
    modalBackdrop.setAttribute("aria-hidden", "true");
    showModalError("");
  }

  modalCloseBtn.addEventListener("click", closeModal);
  cancelBtn.addEventListener("click", closeModal);

  modalBackdrop.addEventListener("click", (e) => {
    if (e.target === modalBackdrop) closeModal();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !modalBackdrop.classList.contains("hidden")) {
      closeModal();
    }
  });

  saveBtn.addEventListener("click", async () => {
    if (editingId == null) return;

    const text = modalTextEl.value.trim();
    const due_date = modalDueEl.value ? modalDueEl.value : null;

    const priority = parseInt(modalPriorityEl.value, 10);
    if (!Number.isFinite(priority) || priority < 0 || priority > 3) {
      showModalError("Priority must be 0..3.");
      modalPriorityEl.focus();
      return;
    }

    const unitRaw = modalRecurUnitEl.value;
    const recurrence_unit = unitRaw === "none" ? null : unitRaw;

    let recurrence_interval = null;
    if (recurrence_unit) {
      const n = parseInt(modalRecurIntervalEl.value, 10);
      if (!Number.isFinite(n) || n <= 0) {
        showModalError("Recurrence interval must be a positive integer.");
        modalRecurIntervalEl.focus();
        return;
      }
      if (!due_date) {
        showModalError("Recurring tasks require a due date.");
        modalDueEl.focus();
        return;
      }
      recurrence_interval = n;
    }

    if (!text) {
      showModalError("Task text cannot be empty.");
      modalTextEl.focus();
      return;
    }

    try {
      showModalError("");
      await api(`/api/todos/${editingId}`, {
        method: "PATCH",
        body: JSON.stringify({ text, due_date, priority, recurrence_unit, recurrence_interval }),
      });
      await load();
      closeModal();
    } catch (e) {
      showModalError(e.message);
    }
  });

  // ---- Rendering ----
  function createTrashButton(onClick) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "icon-mini";
    btn.setAttribute("aria-label", "Delete task");
    btn.title = "Delete";
    btn.innerHTML = `
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M3 6h18"></path>
        <path d="M8 6V4h8v2"></path>
        <path d="M6 6l1 16h10l1-16"></path>
        <path d="M10 11v6"></path>
        <path d="M14 11v6"></path>
      </svg>
    `.trim();
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      onClick();
    });
    return btn;
  }

  function createTodoNodeLI(t, childrenMap, { showDue }) {
    const li = document.createElement("li");
    li.className = "todo";

    const dc = dueClass(t);
    if (dc) li.classList.add(dc);
    if (t.done) li.classList.add("done");
    if (selectedId === t.id) li.classList.add("selected");

    const row = document.createElement("div");
    row.className = "item-row";
    row.addEventListener("click", () => {
      selectedId = t.id;
      renderAll();
    });

    const left = document.createElement("div");
    left.className = "left";

    const kids = childrenMap.get(t.id) || [];

    const twisty = document.createElement("button");
    twisty.type = "button";
    twisty.className = "twisty";
    twisty.setAttribute("aria-label", "Toggle subtasks");
    twisty.textContent = isExpanded(t.id) ? "▾" : "▸";
    twisty.addEventListener("click", (ev) => {
      ev.stopPropagation();
      toggleExpanded(t.id);
      renderAll();
    });

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = !!t.done;
    cb.addEventListener("click", (ev) => ev.stopPropagation());
    cb.addEventListener("change", async () => {
      try {
        showError("");
        await api(`/api/todos/${t.id}`, {
          method: "PATCH",
          body: JSON.stringify({ done: cb.checked }),
        });
        await load();
      } catch (e) {
        showError(e.message);
      }
    });

    const stack = document.createElement("div");
    stack.className = "stack";

    const text = document.createElement("div");
    text.className = "text";
    text.title = t.text;
    text.textContent = t.text;
    stack.appendChild(text);

    if (showDue) {
      const sub = document.createElement("div");
      sub.className = "sub";

      const duePart = t.due_date ? `Due: ${t.due_date}` : `Due: (none)`;
      const prioPart = ` · Priority: ${priorityLabel(t.priority)}`;
      const recurPart = t.recurrence_unit
        ? ` · Repeats: every ${t.recurrence_interval || 1} ${t.recurrence_unit}`
        : "";

      sub.textContent = duePart + prioPart + recurPart;
      stack.appendChild(sub);
    }

    left.appendChild(twisty);
    left.appendChild(cb);
    left.appendChild(stack);

    const actions = document.createElement("div");
    actions.className = "actions";

    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "tiny secondary";
    editBtn.textContent = "Edit";
    editBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      selectedId = t.id;
      openModalForTodo(t.id);
    });
    actions.appendChild(editBtn);

    actions.appendChild(createTrashButton(() => softDeleteTodo(t.id)));

    row.appendChild(left);
    row.appendChild(actions);
    li.appendChild(row);

    // Expanded area: inline subtask creation + children
    if (isExpanded(t.id)) {
      const area = document.createElement("div");
      area.className = "children-area";

      const controls = document.createElement("div");
      controls.className = "child-controls";

      const inline = document.createElement("div");
      inline.className = "inline-add";

      const input = document.createElement("input");
      input.type = "text";
      input.placeholder = "New subtask… (Ctrl+Enter)";
      input.setAttribute("aria-label", "New subtask text");

      const addBtn = document.createElement("button");
      addBtn.type = "button";
      addBtn.className = "tiny secondary";
      addBtn.textContent = "Add";

      const addSubtask = async () => {
        const subText = input.value.trim();
        if (!subText) return;

        // Inherit parent's due date and priority
        const due_date = t.due_date ? t.due_date : null;
        const priority = Number.isInteger(t.priority) ? t.priority : 1;

        try {
          showError("");
          await api("/api/todos", {
            method: "POST",
            body: JSON.stringify({
              text: subText,
              due_date,
              parent_id: t.id,
              priority,
              recurrence_unit: null,
              recurrence_interval: null,
            }),
          });

          ensureExpanded(t.id);
          input.value = "";
          await load();
        } catch (e) {
          showError(e.message);
        }
      };

      addBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        addSubtask();
      });

      // Ctrl+Enter creates subtask (as requested)
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && e.ctrlKey) {
          e.preventDefault();
          addSubtask();
        }
      });

      inline.appendChild(input);
      inline.appendChild(addBtn);

      controls.appendChild(inline);

      const hint = document.createElement("div");
      hint.className = "inline-hint";
      hint.textContent = t.due_date
        ? `Subtasks inherit due date: ${t.due_date} · priority: ${priorityLabel(t.priority)}`
        : `Subtasks inherit due date: (none) · priority: ${priorityLabel(t.priority)}`;
      controls.appendChild(hint);

      area.appendChild(controls);

      if (kids.length > 0) {
        const ul = document.createElement("ul");
        ul.className = "children";
        for (const c of kids) {
          ul.appendChild(createTodoNodeLI(c, childrenMap, { showDue }));
        }
        area.appendChild(ul);
      }

      li.appendChild(area);
    }

    return li;
  }

  function renderForest(containerEl, items, { showDue }) {
    containerEl.innerHTML = "";
    const { roots, children } = forestFromItems(items);
    for (const r of roots) {
      containerEl.appendChild(createTodoNodeLI(r, children, { showDue }));
    }
  }

  function renderListView(items) {
    renderForest(listEl, items, { showDue: true });
  }

  function renderDayPanel(items) {
    const d = fromYMD(selectedDate);
    dayTitleEl.textContent = selectedDate;
    daySubtitleEl.textContent = d.toLocaleString(undefined, {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
    });

    const dueToday = items.filter((t) => t.due_date === selectedDate);
    const undated = items.filter((t) => !t.due_date);

    renderForest(dayListEl, dueToday, { showDue: false });
    renderForest(undatedListEl, undated, { showDue: false });
  }

  function renderCalendar(items) {
    calTitleEl.textContent = fmtMonthTitle(calMonth);

    const gridDays = monthRangeGrid(calMonth);
    const byDate = countByDueDate(items);

    calGridEl.innerHTML = "";

    for (const name of DOW) {
      const el = document.createElement("div");
      el.className = "cal-dow";
      el.textContent = name;
      calGridEl.appendChild(el);
    }

    const thisMonth = calMonth.getMonth();

    for (const d of gridDays) {
      const cell = document.createElement("div");
      cell.className = "cal-cell";

      const ymd = toYMD(d);
      const inMonth = d.getMonth() === thisMonth;

      if (!inMonth) cell.classList.add("muted");
      if (ymd === selectedDate) cell.classList.add("selected");

      const daynum = document.createElement("div");
      daynum.className = "cal-daynum";
      daynum.textContent = String(d.getDate());
      cell.appendChild(daynum);

      const counts = byDate.get(ymd);
      if (counts && counts.total > 0) {
        const badges = document.createElement("div");
        badges.className = "cal-badges";

        const b1 = document.createElement("span");
        b1.className = "badge";
        b1.textContent = `${counts.total} task${counts.total === 1 ? "" : "s"}`;
        badges.appendChild(b1);

        if (counts.done > 0) {
          const b2 = document.createElement("span");
          b2.className = "badge";
          b2.textContent = `${counts.done} done`;
          badges.appendChild(b2);
        }

        cell.appendChild(badges);

        // Per-day completion bar
        const ratio = counts.done / counts.total;
        const track = document.createElement("div");
        track.className = "day-progress-track";
        const fill = document.createElement("div");
        fill.className = "day-progress-fill";
        fill.style.width = `${Math.round(ratio * 100)}%`;
        fill.style.backgroundColor = ratioToColor(ratio);
        track.appendChild(fill);
        cell.appendChild(track);
      }

      cell.addEventListener("click", () => {
        selectedDate = ymd;
        if (!inMonth) calMonth = new Date(d.getFullYear(), d.getMonth(), 1);
        renderAll();
      });

      calGridEl.appendChild(cell);
    }
  }

  function getVisibleTodos() {
    return applySearchFilter(todos);
  }

  function renderAll() {
    const visible = getVisibleTodos();
    stats(visible);

    renderListView(visible);
    if (currentView === "calendar") renderCalendar(visible);
    if (currentView === "calendar") renderDayPanel(visible);
  }

  async function load() {
    try {
      showError("");
      todos = await api("/api/todos");
      // If selection points to a missing task (deleted), clear it
      if (selectedId != null && !todos.some((t) => t.id === selectedId)) {
        selectedId = null;
      }
      renderAll();
    } catch (e) {
      showError(e.message);
    }
  }

  // Calendar nav
  prevMonthBtn.addEventListener("click", () => {
    calMonth = new Date(calMonth.getFullYear(), calMonth.getMonth() - 1, 1);
    renderAll();
  });
  nextMonthBtn.addEventListener("click", () => {
    calMonth = new Date(calMonth.getFullYear(), calMonth.getMonth() + 1, 1);
    renderAll();
  });
  todayBtn.addEventListener("click", () => {
    const now = new Date();
    calMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    selectedDate = toYMD(now);
    renderAll();
  });

  // Create root task (Enter)
  formEl.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const text = textEl.value.trim();
    if (!text) return;

    const due_date = dueDateEl.value ? dueDateEl.value : null;

    const priority = parseInt(priorityEl.value, 10);
    const p = Number.isFinite(priority) ? priority : 1;

    try {
      showError("");
      await api("/api/todos", {
        method: "POST",
        body: JSON.stringify({
          text,
          due_date,
          parent_id: null,
          priority: p,
          recurrence_unit: null,
          recurrence_interval: null,
        }),
      });

      textEl.value = "";
      dueDateEl.value = todayYMD();
      await load();
    } catch (e) {
      showError(e.message);
    }
  });

  // Clear done (soft-deletes done tasks; no undo toast here)
  clearDoneBtn.addEventListener("click", async () => {
    try {
      showError("");
      const done = todos.filter((t) => t.done);
      for (const t of done) {
        await api(`/api/todos/${t.id}`, { method: "DELETE" });
      }
      await load();
    } catch (e) {
      showError(e.message);
    }
  });

  // ---- Keyboard shortcuts ----
  function isTypingTarget(el) {
    if (!el) return false;
    const tag = (el.tagName || "").toLowerCase();
    return tag === "input" || tag === "textarea" || tag === "select" || el.isContentEditable;
  }

  document.addEventListener("keydown", (e) => {
    // Don’t steal keys while modal is open
    if (!modalBackdrop.classList.contains("hidden")) return;

    // `/` focuses search
    if (e.key === "/") {
      e.preventDefault();
      searchEl.focus();
      searchEl.select?.();
      return;
    }

    // If user is typing in any input, don’t run global shortcuts
    if (isTypingTarget(e.target)) return;

    // `e` edit selected
    if (e.key === "e" || e.key === "E") {
      if (selectedId != null) openModalForTodo(selectedId);
      return;
    }

    // `d` toggle done selected
    if (e.key === "d" || e.key === "D") {
      if (selectedId == null) return;
      const t = todos.find((x) => x.id === selectedId);
      if (!t) return;

      (async () => {
        try {
          await api(`/api/todos/${t.id}`, {
            method: "PATCH",
            body: JSON.stringify({ done: !t.done }),
          });
          await load();
        } catch (err) {
          showError(err.message);
        }
      })();

      return;
    }
  });

  load();
})();

