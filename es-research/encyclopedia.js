const API = '/api/encyclopedia';
const MAX_BACKUP_SIZE = 64_000_000;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function button(text, action, className = '') {
  const node = element('button', className, text);
  node.type = 'button';
  if (action) node.dataset.action = action;
  return node;
}

function label(text, input) {
  const node = element('label', 'encyclopedia-label');
  node.append(element('span', '', text), input);
  return node;
}

function input(type, value = '', name = '') {
  const node = document.createElement('input');
  node.type = type;
  node.value = value ?? '';
  if (name) node.name = name;
  return node;
}

function option(text, value) {
  const node = element('option', '', text);
  node.value = value;
  return node;
}

function tagSet(caseItem) {
  return new Set(caseItem.tagIds ?? []);
}

export function filterCases(cases, { setupId = '', tagIds = [], tagMode = 'all', query = '' } = {}) {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  return cases.filter(item => {
    if (setupId && !item.setupIds.includes(setupId)) return false;
    const tags = tagSet(item);
    if (tagIds.length && (tagMode === 'any'
      ? !tagIds.some(id => tags.has(id))
      : !tagIds.every(id => tags.has(id)))) return false;
    if (normalizedQuery) {
      const text = `${item.date} bar ${item.barNumber} ${item.notes ?? ''} ${item.setupIds.join(' ')} ${item.tagIds.join(' ')}`.toLocaleLowerCase();
      if (!text.includes(normalizedQuery)) return false;
    }
    return true;
  }).sort((a, b) => b.time - a.time || a.id.localeCompare(b.id));
}

function contextCopy(context) {
  if (!context || !context.date || !Number.isInteger(Number(context.barNumber)) || !Number.isFinite(Number(context.time))) {
    throw new Error('请先在图表中定位到有效的信号 K 线。');
  }
  return {
    date: context.date,
    barNumber: Number(context.barNumber),
    time: Number(context.time),
    interval: Number(context.interval),
    session: context.session,
    adjustment: context.adjustment,
    rollRevision: context.rollRevision ?? '',
    dataSource: context.dataSource ?? 'ES',
  };
}

function emptySnapshot() { return { version: 1, setups: [], tags: [], cases: [] }; }

function normalizeFilters(state) {
  if (!state.snapshot.setups.some(item => item.id === state.setupFilter)) state.setupFilter = '';
  const validTags = new Set(state.snapshot.tags.map(item => item.id));
  state.selectedFilterTags = new Set([...state.selectedFilterTags].filter(id => validTags.has(id)));
}

export function createCaseDraft(anchor, { setupIds = [], tagIds = [], notes = '' } = {}) {
  return { anchor: anchor ? contextCopy(anchor) : null, setupIds: [...setupIds], tagIds: [...tagIds], notes };
}

export function caseFromDraft(draft) {
  if (!draft?.anchor) throw new Error('请先选择信号 K 线。');
  return { ...draft.anchor, setupIds: [...draft.setupIds], tagIds: [...draft.tagIds], notes: draft.notes.trim() };
}

export function createEncyclopedia({ host, onNavigate = () => {}, onCapture = () => null }) {
  if (!host) throw new Error('缺少百科侧栏容器。');
  const state = {
    snapshot: emptySnapshot(), selection: null, newDraft: null, editCaseId: null, editDraft: null,
    setupFilter: '', selectedFilterTags: new Set(), tagMode: 'all', query: '',
    activeCaseId: null, status: '', busy: false, loaded: false, ready: false, navigationId: 0,
    quickNames: { setup: '', tag: '' },
  };

  const shell = element('div', 'encyclopedia-shell');
  const heading = element('div', 'encyclopedia-heading');
  const title = element('div', 'encyclopedia-title');
  title.append(element('strong', '', '阿布图表百科'), element('span', 'encyclopedia-count', ''));
  heading.append(title, button('收起', 'close', 'encyclopedia-close'));
  const toolbar = element('div', 'encyclopedia-toolbar');
  toolbar.append(button('＋ 收录信号 K 线', 'capture', 'encyclopedia-primary'), button('新案例', 'new-case'));
  const message = element('p', 'encyclopedia-status');
  message.setAttribute('role', 'status');
  message.setAttribute('aria-live', 'polite');
  const filters = element('section', 'encyclopedia-filters');
  filters.setAttribute('aria-label', '筛选案例');
  const filterSetup = document.createElement('select');
  filterSetup.name = 'setupFilter';
  filterSetup.setAttribute('aria-label', '按 setup 筛选');
  const tagFilters = element('div', 'encyclopedia-filter-tags');
  const tagMode = document.createElement('select');
  tagMode.name = 'tagMode';
  tagMode.setAttribute('aria-label', '标签组合方式');
  tagMode.append(option('标签需全部满足', 'all'), option('标签满足任一', 'any'));
  const search = input('search', '', 'query');
  search.placeholder = '搜索案例笔记';
  search.setAttribute('aria-label', '搜索案例笔记');
  const filterTop = element('div', 'encyclopedia-filter-top');
  filterTop.append(filterSetup, tagMode);
  filters.append(filterTop, tagFilters, search);
  const navigation = element('div', 'encyclopedia-navigation');
  navigation.append(button('← 上一个', 'previous'), element('span', 'encyclopedia-current', ''), button('下一个 →', 'next'));
  const caseList = element('div', 'encyclopedia-cases');
  caseList.setAttribute('aria-label', '案例列表');
  caseList.tabIndex = 0;
  const editor = element('section', 'encyclopedia-editor');
  editor.setAttribute('aria-label', '案例编辑器');
  const management = element('details', 'encyclopedia-management');
  const managementSummary = element('summary', '', '管理 setup 与标签');
  const managementContent = element('div', 'encyclopedia-management-content');
  management.append(managementSummary, managementContent);
  const backup = element('div', 'encyclopedia-backup');
  backup.append(button('导出百科 JSON', 'export'));
  const importLabel = element('label', 'encyclopedia-import', '恢复百科 JSON');
  const importPicker = input('file');
  importPicker.accept = '.json,application/json';
  importPicker.name = 'import';
  importLabel.append(importPicker);
  backup.append(importLabel);
  const retryButton = button('重试加载百科', 'retry');
  retryButton.hidden = true;
  toolbar.append(retryButton);
  const navToggle = document.getElementById('encyclopedia-toggle');
  shell.append(heading, toolbar, message, filters, navigation, caseList, editor, management, backup);
  host.replaceChildren(shell);
  host.classList.add('encyclopedia-host');

  function setStatus(text) {
    state.status = text ?? '';
    message.textContent = state.status;
  }

  function currentEditorData() {
    if (!editor.querySelector('[name="notes"]')) return;
    const form = editor.querySelector('form');
    const mode = form?.dataset.mode;
    const tags = [...editor.querySelectorAll('[name="tagIds"]:checked')].map(node => node.value);
    const setupIds = [...editor.querySelectorAll('[name="setupIds"]:checked')].map(node => node.value);
    const notes = editor.querySelector('[name="notes"]')?.value ?? '';
    if (mode === 'new') state.newDraft = { ...(state.newDraft ?? {}), setupIds, tagIds: tags, notes };
    if (mode === 'edit' && state.editCaseId) state.editDraft = { setupIds, tagIds: tags, notes };
  }

  async function post(body) {
    const response = await fetch(API, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || '百科保存失败');
    state.snapshot = payload;
    normalizeFilters(state);
    return payload;
  }

  async function refresh() {
    try {
      const response = await fetch(API);
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || '百科读取失败');
      state.snapshot = payload;
      normalizeFilters(state);
      state.loaded = true;
      state.ready = true;
      retryButton.hidden = true;
      state.activeCaseId = state.snapshot.cases.some(item => item.id === state.activeCaseId) ? state.activeCaseId : null;
      render();
      setStatus(state.snapshot.setups.length ? '' : '收录信号 K 线后，可在案例中直接新建 setup 和标签。');
    } catch (error) {
      state.ready = false;
      setStatus(`百科暂不可用：${error.message}。可以重试加载；图表仍可照常使用。`);
      retryButton.hidden = false;
      renderList();
      syncEnabled();
    }
  }

  function makeCheckList(items, name, selectedIds, emptyText) {
    const group = element('div', 'encyclopedia-checks');
    if (!items.length) group.append(element('span', 'encyclopedia-empty', emptyText));
    for (const item of items) {
      const check = input('checkbox', '', name);
      check.value = item.id;
      check.checked = selectedIds.includes(item.id);
      const row = element('label', 'encyclopedia-check');
      row.append(check, element('span', '', item.name));
      group.append(row);
    }
    return group;
  }

  function drawEditor() {
    editor.replaceChildren();
    if (!state.newDraft && !state.editCaseId) return;
    let draft = state.newDraft;
    const existing = state.editCaseId ? state.snapshot.cases.find(item => item.id === state.editCaseId) : null;
    if (state.editCaseId && !existing) { state.editCaseId = null; return; }
    const isEdit = Boolean(existing);
    draft ??= {};
    const form = document.createElement('form');
    form.dataset.mode = isEdit ? 'edit' : 'new';
    form.dataset.action = 'save-case';
    const heading = element('div', 'encyclopedia-editor-heading');
    heading.append(element('strong', '', isEdit ? '编辑案例' : '新案例'), button('关闭', 'close-editor'));
    const anchor = isEdit ? existing : draft.anchor;
    const anchorText = anchor
      ? `${anchor.date} · bar ${anchor.barNumber} · ${anchor.interval} 分钟 ${anchor.session.toUpperCase()}`
      : '未选择信号 K 线';
    const anchorStatus = element('p', 'encyclopedia-anchor', `信号 K 线：${anchorText}`);
    form.append(heading, anchorStatus);
    if (!isEdit && !anchor) form.append(button('从图表选择信号 K 线', 'capture', 'encyclopedia-primary'));
    const setupIds = (isEdit ? state.editDraft?.setupIds ?? existing.setupIds : draft.setupIds) ?? [];
    const tagIds = (isEdit ? state.editDraft?.tagIds ?? existing.tagIds : draft.tagIds) ?? [];
    const setupGroup = element('fieldset', 'encyclopedia-choice-group');
    setupGroup.append(element('legend', '', 'Setup · 背景与入场理由'));
    setupGroup.append(makeCheckList(state.snapshot.setups, 'setupIds', setupIds, '请先创建 setup'));
    setupGroup.append(quickChoice('setup', '新建 setup', '例如：big gap up and low2 top', 80));
    form.append(setupGroup);
    const tagGroup = element('fieldset', 'encyclopedia-choice-group');
    tagGroup.append(element('legend', '', '特性标签 · 不利因素与微观因素'));
    tagGroup.append(makeCheckList(state.snapshot.tags, 'tagIds', tagIds, '可先创建标签，也可以不添加标签'));
    tagGroup.append(quickChoice('tag', '新建标签', '例如：strong buying', 60));
    form.append(tagGroup);
    const notes = document.createElement('textarea');
    notes.name = 'notes';
    notes.rows = 3;
    notes.maxLength = 4000;
    notes.placeholder = '可选：补充复盘观察';
    notes.value = isEdit ? state.editDraft?.notes ?? existing.notes ?? '' : draft.notes ?? '';
    form.append(label('备注（可选）', notes));
    const actions = element('div', 'encyclopedia-editor-actions');
    actions.append(button(isEdit ? '保存修改' : '保存案例', null, 'encyclopedia-primary'));
    actions.querySelector('button').type = 'submit';
    if (isEdit) actions.append(button('删除案例', 'delete-case', 'encyclopedia-danger'));
    form.append(actions);
    editor.append(form);
  }

  function quickChoice(kind, title, placeholder, maxLength) {
    const row = element('div', 'encyclopedia-quick-choice');
    const field = input('text', state.quickNames[kind], `quick-${kind}`);
    field.maxLength = maxLength;
    field.placeholder = placeholder;
    row.append(label(title, field), button('添加并选中', `quick-${kind}`));
    return row;
  }

  async function addEditorChoice(kind) {
    currentEditorData();
    const name = state.quickNames[kind].trim();
    if (!name) throw new Error(kind === 'setup' ? '请输入 setup 名称。' : '请输入标签名称。');
    const collection = kind === 'setup' ? 'setups' : 'tags';
    const field = kind === 'setup' ? 'setupIds' : 'tagIds';
    const find = () => state.snapshot[collection].find(item => item.name.toLocaleLowerCase() === name.toLocaleLowerCase());
    state.busy = true;
    syncEnabled();
    let item = find();
    if (!item) {
      setStatus('正在创建并选中…');
      await post({ action: kind === 'setup' ? 'saveSetup' : 'saveTag', item: { name, ...(kind === 'setup' ? { description: '' } : {}) } });
      item = find();
    }
    if (!item) throw new Error('未找到新建条目，请重试。');
    const draft = state.editCaseId ? state.editDraft : state.newDraft;
    draft[field] = [...new Set([...draft[field], item.id])];
    state.quickNames[kind] = '';
    render();
    setStatus(`${kind === 'setup' ? 'Setup' : '标签'}“${item.name}”已选中，可继续保存案例。`);
  }

  function drawManagement() {
    managementContent.replaceChildren();
    const setupForm = document.createElement('form');
    setupForm.dataset.action = 'save-setup';
    const editingSetupId = management.dataset.editSetup ?? '';
    const setup = state.snapshot.setups.find(item => item.id === editingSetupId);
    const setupTitle = element('strong', '', setup ? '编辑 setup' : '新增 setup');
    const setupName = input('text', setup?.name ?? '', 'name');
    setupName.maxLength = 80;
    setupName.required = true;
    setupName.placeholder = '例如：big gap up and low2 top';
    const description = document.createElement('textarea');
    description.name = 'description';
    description.rows = 2;
    description.maxLength = 1000;
    description.placeholder = '背景与入场理由';
    description.value = setup?.description ?? '';
    const setupActions = element('div', 'encyclopedia-management-actions');
    const saveSetup = button(setup ? '保存' : '新增 setup'); saveSetup.type = 'submit';
    setupActions.append(saveSetup);
    if (setup) setupActions.append(button('取消', 'cancel-setup'));
    setupForm.append(setupTitle, label('名称', setupName), label('背景与入场理由', description), setupActions);
    managementContent.append(setupForm);

    const tagForm = document.createElement('form');
    tagForm.dataset.action = 'save-tag';
    const editingTagId = management.dataset.editTag ?? '';
    const tag = state.snapshot.tags.find(item => item.id === editingTagId);
    const tagName = input('text', tag?.name ?? '', 'name');
    tagName.maxLength = 60;
    tagName.required = true;
    tagName.placeholder = '例如：strong buying';
    const tagActions = element('div', 'encyclopedia-management-actions');
    const saveTag = button(tag ? '保存' : '新增标签'); saveTag.type = 'submit';
    tagActions.append(saveTag);
    if (tag) tagActions.append(button('取消', 'cancel-tag'));
    tagForm.append(element('strong', '', tag ? '编辑标签' : '新增标签'), label('名称', tagName), tagActions);
    managementContent.append(tagForm);

    const groups = [
      ['Setups', state.snapshot.setups, 'setup'],
      ['标签', state.snapshot.tags, 'tag'],
    ];
    for (const [headingText, items, type] of groups) {
      const list = element('div', 'encyclopedia-managed-list');
      list.append(element('strong', '', headingText));
      if (!items.length) list.append(element('span', 'encyclopedia-empty', '暂无'));
      for (const item of items) {
        const row = element('div', 'encyclopedia-managed-item');
        row.append(element('span', '', `${item.name}${type === 'setup' && item.description ? ` · ${item.description}` : ''}`));
        row.append(button('改名 / 编辑', `edit-${type}`, 'encyclopedia-small'));
        row.lastElementChild.dataset.id = item.id;
        const remove = button('删除', `delete-${type}`, 'encyclopedia-small encyclopedia-danger');
        remove.dataset.id = item.id;
        row.append(remove);
        list.append(row);
      }
      managementContent.append(list);
    }
  }

  function drawFilters() {
    normalizeFilters(state);
    const keepSetup = state.setupFilter;
    filterSetup.replaceChildren(option('全部 setup', ''));
    for (const setup of state.snapshot.setups) filterSetup.append(option(setup.name, setup.id));
    filterSetup.value = state.snapshot.setups.some(setup => setup.id === keepSetup) ? keepSetup : '';
    tagFilters.replaceChildren();
    if (!state.snapshot.tags.length) tagFilters.append(element('span', 'encyclopedia-empty', '还没有特性标签'));
    for (const tag of state.snapshot.tags) {
      const check = input('checkbox', '', 'filterTag');
      check.value = tag.id;
      check.checked = state.selectedFilterTags.has(tag.id);
      const row = element('label', 'encyclopedia-filter-tag');
      row.append(check, element('span', '', tag.name));
      tagFilters.append(row);
    }
    tagMode.value = state.tagMode;
    search.value = state.query;
  }

  function visibleCases() {
    return filterCases(state.snapshot.cases, {
      setupId: state.setupFilter,
      tagIds: [...state.selectedFilterTags],
      tagMode: state.tagMode,
      query: state.query,
    });
  }

  function renderList() {
    const scrollTop = caseList.scrollTop;
    const cases = visibleCases();
    caseList.replaceChildren();
    if (!state.loaded) caseList.append(element('p', 'encyclopedia-empty', '百科数据加载中…'));
    else if (!cases.length) caseList.append(element('p', 'encyclopedia-empty', state.snapshot.cases.length ? '没有符合筛选条件的案例。' : '还没有案例，点击“收录信号 K 线”开始。'));
    for (const item of cases) {
      const card = element('article', `encyclopedia-case${item.id === state.activeCaseId ? ' is-active' : ''}`);
      const select = button('', 'navigate', 'encyclopedia-case-select');
      select.dataset.id = item.id;
      select.setAttribute('aria-current', item.id === state.activeCaseId ? 'true' : 'false');
      select.append(element('strong', 'encyclopedia-case-date', `${item.date} · bar ${item.barNumber}`));
      const setups = item.setupIds.map(id => state.snapshot.setups.find(entry => entry.id === id)).filter(Boolean);
      select.append(element('span', 'encyclopedia-case-setups', setups.map(entry => entry.name).join(' · ') || '（已删除的 setup）'));
      const descriptions = setups.map(entry => entry.description?.trim()).filter(Boolean);
      if (descriptions.length) select.append(element('span', 'encyclopedia-case-context', descriptions.join('；')));
      const tagRow = element('span', 'encyclopedia-case-tags');
      for (const id of item.tagIds) {
        const value = state.snapshot.tags.find(entry => entry.id === id);
        if (value) tagRow.append(element('span', 'encyclopedia-chip', value.name));
      }
      if (tagRow.childNodes.length) select.append(tagRow);
      if (item.notes) select.append(element('span', 'encyclopedia-case-notes', item.notes));
      card.append(select, button('编辑', 'edit-case', 'encyclopedia-small'));
      card.lastElementChild.dataset.id = item.id;
      caseList.append(card);
    }
    caseList.scrollTop = scrollTop;
    const index = cases.findIndex(item => item.id === state.activeCaseId);
    navigation.querySelector('.encyclopedia-current').textContent = cases.length ? `${index >= 0 ? index + 1 : '—'} / ${cases.length}` : '0 / 0';
    navigation.querySelector('[data-action="previous"]').disabled = cases.length < 2 || index <= 0;
    navigation.querySelector('[data-action="next"]').disabled = cases.length < 2 || index < 0 || index >= cases.length - 1;
    title.querySelector('.encyclopedia-count').textContent = `${state.snapshot.cases.length} 个案例`;
  }

  function render() {
    drawFilters();
    renderList();
    drawEditor();
    drawManagement();
    message.textContent = state.status;
    syncEnabled();
  }

  function syncEnabled() {
    const canEdit = state.ready && !state.busy;
    toolbar.querySelector('[data-action="capture"]').disabled = !canEdit;
    toolbar.querySelector('[data-action="new-case"]').disabled = !canEdit;
    backup.querySelectorAll('button,input').forEach(control => { control.disabled = !canEdit; });
    managementContent.querySelectorAll('input,textarea,button').forEach(control => { control.disabled = !canEdit; });
    editor.querySelectorAll('input,textarea,button').forEach(control => { control.disabled = !canEdit; });
  }

  function startNew(context = state.selection) {
    currentEditorData();
    if ((state.newDraft || state.editCaseId) && !confirm('当前编辑器有未保存内容。开始另一条案例并放弃这些修改吗？')) return;
    state.editCaseId = null;
    if (context) state.selection = contextCopy(context);
    state.newDraft = createCaseDraft(state.selection);
    host.hidden = false;
    if (navToggle) navToggle.setAttribute('aria-expanded', 'true');
    render();
    editor.scrollIntoView?.({ block: 'nearest' });
  }

  async function capture(context) {
    currentEditorData();
    const anchor = context ? contextCopy(context) : contextCopy(await onCapture());
    state.selection = anchor;
    if (state.editCaseId) {
      host.hidden = false;
      if (navToggle) navToggle.setAttribute('aria-expanded', 'true');
      setStatus(`图表已选中 ${anchor.date} bar ${anchor.barNumber}；正在编辑的案例与修改保持不变。`);
      return anchor;
    }
    state.editCaseId = null;
    state.newDraft ??= createCaseDraft(anchor);
    if (!state.newDraft.anchor) state.newDraft.anchor = anchor;
    host.hidden = false;
    if (navToggle) navToggle.setAttribute('aria-expanded', 'true');
    render();
    const draftAnchor = state.newDraft.anchor;
    const changed = draftAnchor && (draftAnchor.time !== anchor.time || draftAnchor.interval !== anchor.interval);
    setStatus(changed
      ? `图表已选中 ${anchor.date} bar ${anchor.barNumber}；未保存草稿仍固定于 ${draftAnchor.date} bar ${draftAnchor.barNumber}。`
      : '已选择信号 K 线。');
    return anchor;
  }

  async function navigate(item) {
    const navigationId = ++state.navigationId;
    setStatus(`正在跳转到 ${item.date} bar ${item.barNumber}…`);
    try {
      await onNavigate(item);
      if (navigationId !== state.navigationId) return false;
      state.activeCaseId = item.id;
      renderList();
      setStatus('');
      return true;
    } catch (error) {
      if (navigationId !== state.navigationId || error.name === 'AbortError') return false;
      setStatus(`跳转失败：${error.message}`);
      return false;
    }
  }

  async function handleClick(event) {
    const target = event.target.closest('[data-action]');
    if (!target || !host.contains(target) || state.busy) return;
    const action = target.dataset.action;
    if (!state.ready && ['new-case', 'edit-case', 'delete-case', 'delete-setup', 'delete-tag', 'edit-setup', 'edit-tag', 'export'].includes(action)) return;
    const id = target.dataset.id;
    try {
      if (action === 'quick-setup' || action === 'quick-tag') { await addEditorChoice(action === 'quick-setup' ? 'setup' : 'tag'); return; }
      if (action === 'close') { currentEditorData(); host.hidden = true; if (navToggle) navToggle.setAttribute('aria-expanded', 'false'); return; }
      if (action === 'capture') { await capture(); return; }
      if (action === 'new-case') { startNew(); return; }
      if (action === 'close-editor') { currentEditorData(); state.editCaseId = null; state.newDraft = null; render(); return; }
      if (action === 'retry') { await refresh(); return; }
      if (action === 'navigate' || action === 'edit-case') {
        const item = state.snapshot.cases.find(entry => entry.id === id);
        if (!item) return;
        if (action === 'navigate') await navigate(item);
        else { currentEditorData(); state.editCaseId = id; state.editDraft = null; render(); }
        return;
      }
      if (action === 'previous' || action === 'next') {
        const cases = visibleCases();
        const at = cases.findIndex(item => item.id === state.activeCaseId);
        const item = cases[at + (action === 'next' ? 1 : -1)];
        if (item) await navigate(item);
        return;
      }
      if (action === 'cancel-setup') { delete management.dataset.editSetup; drawManagement(); return; }
      if (action === 'cancel-tag') { delete management.dataset.editTag; drawManagement(); return; }
      if (action === 'edit-setup') { management.dataset.editSetup = id; drawManagement(); return; }
      if (action === 'edit-tag') { management.dataset.editTag = id; drawManagement(); return; }
      if (action === 'delete-setup' || action === 'delete-tag') {
        const type = action === 'delete-setup' ? 'setup' : 'tag';
        const item = state.snapshot[type === 'setup' ? 'setups' : 'tags'].find(entry => entry.id === id);
        if (!item || !confirm(`删除“${item.name}”？只有未被案例使用的${type === 'setup' ? ' setup' : '标签'}可以删除。`)) return;
        currentEditorData();
        state.busy = true;
        setStatus('正在删除…');
        await post({ action: `delete${type[0].toUpperCase()}${type.slice(1)}`, id });
        render(); setStatus('已删除。');
        return;
      }
      if (action === 'delete-case') {
        const item = state.snapshot.cases.find(entry => entry.id === state.editCaseId);
        if (!item || !confirm(`删除 ${item.date} bar ${item.barNumber}？`)) return;
        currentEditorData();
        state.busy = true;
        await post({ action: 'deleteCase', id: item.id });
        state.editCaseId = null; state.editDraft = null; state.activeCaseId = null; render(); setStatus('案例已删除。');
        return;
      }
      if (action === 'export') {
        const blob = new Blob([JSON.stringify(state.snapshot)], { type: 'application/json' });
        if (blob.size > MAX_BACKUP_SIZE) throw new Error('百科备份超过 64 MB，无法导出。');
        const url = URL.createObjectURL(blob);
        const link = element('a'); link.href = url; link.download = 'abu-chart-encyclopedia.json';
        link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
        return;
      }
    } catch (error) { setStatus(error.message); }
    finally { state.busy = false; syncEnabled(); }
  }

  async function handleSubmit(event) {
    const form = event.target.closest('form[data-action]');
    if (!form || !host.contains(form)) return;
    event.preventDefault();
    if (state.busy || !state.ready) return;
    const action = form.dataset.action;
    const values = new FormData(form);
    state.busy = true;
    try {
      if (action === 'save-case') {
        const existing = state.editCaseId ? state.snapshot.cases.find(item => item.id === state.editCaseId) : null;
        const anchor = existing ?? state.newDraft?.anchor;
        if (!anchor) throw new Error('请先选择信号 K 线。');
        const fields = {
          setupIds: [...form.querySelectorAll('[name="setupIds"]:checked')].map(node => node.value),
          tagIds: [...form.querySelectorAll('[name="tagIds"]:checked')].map(node => node.value),
          notes: String(values.get('notes') ?? '').trim(),
        };
        const item = existing ? { ...existing, ...fields } : caseFromDraft({ ...state.newDraft, ...fields });
        if (existing) item.id = existing.id;
        if (!item.setupIds.length) throw new Error('请至少选择一个 setup。');
        setStatus('正在保存案例…');
        await post({ action: 'saveCase', item });
        state.activeCaseId = item.id ?? state.snapshot.cases.find(entry => entry.time === item.time)?.id ?? null;
        state.selection = anchor;
        state.editCaseId = null;
        state.editDraft = null;
        state.newDraft = null;
        render();
        setStatus('案例已保存。');
      } else if (action === 'save-setup') {
        currentEditorData();
        const id = management.dataset.editSetup;
        setStatus('正在保存 setup…');
        await post({ action: 'saveSetup', item: { id, name: values.get('name'), description: values.get('description') } });
        delete management.dataset.editSetup; render(); setStatus('Setup 已保存。');
      } else if (action === 'save-tag') {
        currentEditorData();
        const id = management.dataset.editTag;
        setStatus('正在保存标签…');
        await post({ action: 'saveTag', item: { id, name: values.get('name') } });
        delete management.dataset.editTag; render(); setStatus('标签已保存。');
      }
    } catch (error) { setStatus(error.message); }
    finally { state.busy = false; syncEnabled(); }
  }

  async function importFile(file) {
    if (!file) return;
    try {
      if (file.size > MAX_BACKUP_SIZE) throw new Error('百科备份不能超过 64 MB。');
      const data = JSON.parse(await file.text());
      if (!confirm('恢复备份会替换当前全部 setup、标签和案例。确定继续吗？')) return;
      state.busy = true;
      setStatus('正在验证并恢复百科…');
      await post({ action: 'import', data });
      state.ready = true;
      state.activeCaseId = null; state.newDraft = null; state.editCaseId = null; state.editDraft = null;
      render(); setStatus('百科备份已恢复。');
    } catch (error) { setStatus(`恢复失败：${error.message}`); }
    finally { state.busy = false; importFileInput.value = ''; syncEnabled(); }
  }
  const importFileInput = importPicker;

  shell.addEventListener('click', handleClick);
  shell.addEventListener('submit', handleSubmit);
  shell.addEventListener('change', event => {
    const target = event.target;
    if (target === filterSetup) { state.setupFilter = target.value; renderList(); }
    else if (target === tagMode) { state.tagMode = target.value; renderList(); }
    else if (target.name === 'filterTag') {
      target.checked ? state.selectedFilterTags.add(target.value) : state.selectedFilterTags.delete(target.value);
      renderList();
    } else if (target.name === 'import') importFile(target.files?.[0]);
    else if (target.name === 'setupIds' || target.name === 'tagIds') currentEditorData();
  });
  shell.addEventListener('input', event => {
    if (event.target === search) { state.query = search.value; renderList(); }
    if (event.target.name === 'quick-setup') state.quickNames.setup = event.target.value;
    if (event.target.name === 'quick-tag') state.quickNames.tag = event.target.value;
  });
  shell.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.isComposing && ['quick-setup', 'quick-tag'].includes(event.target.name)) {
      event.preventDefault();
      editor.querySelector(`[data-action="${event.target.name}"]`)?.click();
    }
  });
  render();
  void refresh();

  return {
    capture,
    setSelection(context) {
      try { state.selection = context ? contextCopy(context) : null; }
      catch { state.selection = null; }
    },
    setStatus,
    refresh,
    open() { host.hidden = false; if (navToggle) navToggle.setAttribute('aria-expanded', 'true'); },
  };
}
