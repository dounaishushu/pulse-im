<script lang="ts">
export interface ComposerDraftText {
  text: string;
  start?: number;
  end?: number;
  direction?: "forward" | "backward" | "none";
}
</script>

<script setup lang="ts">
import {
  h,
  onBeforeUnmount,
  onMounted,
  render,
  useTemplateRef,
  watch,
} from "vue";
import { Fragment, Schema, type Node } from "prosemirror-model";
import {
  EditorState,
  Plugin,
  TextSelection,
  type Command,
} from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { closeHistory, history, redo, undo } from "prosemirror-history";
import { keymap } from "prosemirror-keymap";
import { baseKeymap } from "prosemirror-commands";
import "prosemirror-view/style/prosemirror.css";
import ComposerAttachmentPreview from "./ComposerAttachmentPreview.vue";

const props = defineProps<{
  initial: ComposerDraftText;
  disabled: boolean;
  spellcheck: boolean;
  placeholder: string;
  reason?: string;
  desktop?: boolean;
}>();
const emit = defineEmits<{
  change: [text: string, files: File[]];
  input: [];
  key: [event: KeyboardEvent];
  blur: [];
  files: [files: File[], position?: number];
}>();
const mount = useTemplateRef<HTMLElement>("mount");
let editor: EditorView | undefined;
const textLimit = 5000;
const schema = new Schema({
  nodes: {
    doc: { content: "paragraph" },
    paragraph: {
      content: "inline*",
      parseDOM: [{ tag: "p" }],
      toDOM: () => ["p", 0],
    },
    text: { group: "inline" },
    hard_break: {
      inline: true,
      group: "inline",
      selectable: false,
      parseDOM: [{ tag: "br" }],
      toDOM: () => ["br"],
    },
    attachment: {
      inline: true,
      group: "inline",
      atom: true,
      selectable: false,
      attrs: { id: {}, file: {} },
      leafText: (node) => `[附件：${node.attrs.file.name}]`,
      toDOM: (node) => ["span", String(node.attrs.file.name)],
    },
  },
});
const { doc, paragraph, hard_break: hardBreak, attachment } = schema.nodes;
const leafText = (node: Node) => (node.type === hardBreak ? "\n" : "");
function textNodes(text: string) {
  const nodes: Node[] = [];
  text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .forEach((line, index) => {
      if (index) nodes.push(hardBreak!.create());
      if (line) nodes.push(schema.text(line));
    });
  return Fragment.fromArray(nodes);
}
function plainText(content: Node) {
  return content.textBetween(0, content.content.size, "", leafText);
}
function filesIn(content: Node | Fragment) {
  const files: File[] = [];
  content.descendants((node) => {
    if (node.type === attachment) files.push(node.attrs.file);
  });
  return files;
}
function deleteAttachment(direction: -1 | 1): Command {
  return (state, dispatch) => {
    const { empty, $head } = state.selection;
    if (!empty) return false;
    const sibling = direction < 0 ? $head.nodeBefore : $head.nodeAfter;
    if (!sibling || sibling.type !== attachment) return false;
    const start = direction < 0 ? $head.pos - sibling.nodeSize : $head.pos;
    dispatch?.(
      closeHistory(
        state.tr.delete(start, start + sibling.nodeSize),
      ).scrollIntoView(),
    );
    return true;
  };
}
const removeBefore = deleteAttachment(-1);
const removeAfter = deleteAttachment(1);
const plugins = [
  history(),
  keymap({
    Backspace: removeBefore,
    Delete: removeAfter,
    "Mod-z": undo,
    "Mod-y": redo,
    "Shift-Mod-z": redo,
  }),
  keymap({ ...baseKeymap, Enter: () => false }),
  new Plugin({
    filterTransaction: (transaction) =>
      !transaction.docChanged || plainText(transaction.doc).length <= textLimit,
  }),
];
function attributes(state: EditorState): Record<string, string> {
  return {
    id: "message-input",
    class: state.doc.firstChild?.content.size ? "" : "composer-editor-empty",
    role: "textbox",
    "aria-label": "输入消息",
    "aria-multiline": "true",
    "aria-disabled": String(props.disabled),
    "aria-placeholder": props.placeholder,
    "aria-describedby": props.reason ? "composer-blocked-reason" : "",
    "data-placeholder": props.placeholder,
    spellcheck: String(props.spellcheck),
    title: props.reason || "",
  };
}
function createState(initial: ComposerDraftText) {
  const content = doc!.create(
    null,
    paragraph!.create(null, textNodes(initial.text.slice(0, textLimit))),
  );
  const last = content.firstChild!.content.size;
  const start = Math.max(0, Math.min(initial.start ?? last, last)) + 1;
  const end = Math.max(0, Math.min(initial.end ?? last, last)) + 1;
  const backward = initial.direction === "backward";
  return EditorState.create({
    doc: content,
    selection: TextSelection.create(
      content,
      backward ? end : start,
      backward ? start : end,
    ),
    plugins,
  });
}
function publish(view: EditorView) {
  emit("change", plainText(view.state.doc), filesIn(view.state.doc));
}
function focus() {
  if (!props.disabled) editor?.focus();
}
// selectionchange can arrive after paste or drop. Read the current caret when it
// belongs to this editor, and retain the model selection for toolbar actions.
function currentSelection(view: EditorView) {
  const selection = view.dom.ownerDocument.getSelection();
  const anchor = selection?.anchorNode;
  const head = selection?.focusNode;
  if (
    !view.hasFocus() ||
    !anchor ||
    !head ||
    !view.dom.contains(anchor) ||
    !view.dom.contains(head)
  )
    return view.state.selection;
  const doc = view.state.doc;
  return TextSelection.between(
    doc.resolve(view.posAtDOM(anchor, selection.anchorOffset)),
    doc.resolve(view.posAtDOM(head, selection.focusOffset)),
  );
}
function selection() {
  if (!editor) return undefined;
  const { doc } = editor.state;
  const selection = currentSelection(editor);
  return {
    start: doc.textBetween(0, selection.from, "", leafText).length,
    end: doc.textBetween(0, selection.to, "", leafText).length,
    direction: selection.empty
      ? ("none" as const)
      : selection.anchor <= selection.head
        ? ("forward" as const)
        : ("backward" as const),
  };
}
function beforeCaret() {
  if (!editor) return "";
  return editor.state.doc.textBetween(
    0,
    currentSelection(editor).from,
    "",
    (node) => (node.type === attachment ? "\n" : leafText(node)),
  );
}
function replaceText(text: string, before = 0) {
  if (!editor || props.disabled) return;
  const { doc, tr } = editor.state;
  const selection = currentSelection(editor);
  const from = Math.max(1, selection.from - before);
  const available =
    textLimit -
    plainText(doc).length +
    doc.textBetween(from, selection.to, "", leafText).length;
  const fragment = textNodes(
    text
      .replace(/\r\n?/g, "\n")
      .slice(0, available)
      .replace(/[\uD800-\uDBFF]$/, ""),
  );
  editor.dispatch(
    tr.replaceWith(from, selection.to, fragment).scrollIntoView(),
  );
}
function insertFiles(files: File[], position?: number) {
  if (!editor || props.disabled) return false;
  const { doc, tr } = editor.state;
  const selection = currentSelection(editor);
  const point =
    position == null
      ? undefined
      : Math.min(doc.content.size - 1, Math.max(1, position));
  const from = point ?? selection.from;
  const to = point ?? selection.to;
  const replaces = filesIn(
    paragraph!.create(null, doc.slice(from, to).content),
  );
  if (filesIn(doc).length - replaces.length + files.length > 10) return false;
  const nodes = files.map((file) =>
    attachment!.create({ id: crypto.randomUUID(), file }),
  );
  tr.replaceWith(from, to, nodes);
  tr.setSelection(TextSelection.create(tr.doc, from + nodes.length));
  editor.dispatch(closeHistory(tr).scrollIntoView());
  focus();
  return true;
}
function removeFiles() {
  if (!editor || props.disabled) return;
  const { doc, tr } = editor.state;
  const positions: number[] = [];
  doc.descendants((node, pos) => {
    if (node.type === attachment) positions.push(pos);
  });
  for (const pos of positions.reverse()) tr.delete(pos, pos + 1);
  if (tr.docChanged) editor.dispatch(closeHistory(tr));
  focus();
}
function reset(initial: ComposerDraftText) {
  if (!editor) return;
  editor.updateState(createState(initial));
  publish(editor);
}

onMounted(() => {
  editor = new EditorView(mount.value!, {
    state: createState(props.initial),
    editable: () => !props.disabled,
    attributes,
    dispatchTransaction(transaction) {
      const view = editor!;
      const previous = view.state.doc;
      view.updateState(view.state.apply(transaction));
      if (previous.eq(view.state.doc)) return;
      publish(view);
      if (!view.composing) emit("input");
    },
    nodeViews: {
      attachment(node, view, getPos) {
        const dom = document.createElement("span");
        dom.className = "composer-attachment-node";
        dom.contentEditable = "false";
        render(
          h(ComposerAttachmentPreview, {
            file: node.attrs.file as File,
            onRemove() {
              if (props.disabled) return;
              const pos = getPos();
              if (pos === undefined) return;
              view.dispatch(
                closeHistory(view.state.tr.delete(pos, pos + node.nodeSize)),
              );
              focus();
            },
          }),
          dom,
        );
        return {
          dom,
          stopEvent: (event) =>
            event.target instanceof Element && !!event.target.closest("button"),
          ignoreMutation: (mutation) => mutation.type !== "selection",
          destroy: () => render(null, dom),
        };
      },
    },
    handleKeyDown(view, event) {
      if (view.composing || event.isComposing || event.keyCode === 229)
        return false;
      emit("key", event);
      if (event.defaultPrevented) return true;
      if (event.key === "Enter") {
        view.dispatch(
          view.state.tr
            .replaceSelectionWith(hardBreak!.create())
            .scrollIntoView(),
        );
        return true;
      }
      return false;
    },
    handleDOMEvents: {
      paste(_view, event) {
        if (!event.clipboardData) return false;
        const files = [...event.clipboardData.files];
        event.preventDefault();
        if (files.length) emit("files", files);
        else {
          const text = event.clipboardData.getData("text/plain");
          if (text) replaceText(text);
        }
        return true;
      },
      drop(view, event) {
        const files = [...(event.dataTransfer?.files || [])];
        if (!files.length) return false;
        event.preventDefault();
        event.stopPropagation();
        const point = view.posAtCoords({
          left: event.clientX,
          top: event.clientY,
        });
        emit("files", files, point?.pos);
        return true;
      },
      beforeinput(view, event) {
        if (event.isComposing || !event.cancelable) return false;
        const remove =
          event.inputType === "deleteContentBackward"
            ? removeBefore
            : event.inputType === "deleteContentForward"
              ? removeAfter
              : undefined;
        if (!remove?.(view.state, view.dispatch)) return false;
        event.preventDefault();
        return true;
      },
      blur() {
        emit("blur");
        return false;
      },
    },
  });
});
watch(
  () => [props.disabled, props.spellcheck, props.placeholder, props.reason],
  () => {
    editor?.setProps({ editable: () => !props.disabled, attributes });
  },
);
onBeforeUnmount(() => editor?.destroy());
defineExpose({
  beforeCaret,
  focus,
  insertFiles,
  removeFiles,
  replaceText,
  reset,
  selection,
});
</script>

<template>
  <div
    ref="mount"
    class="composer-editor"
    :class="{ 'composer-editor-desktop': desktop }"
  />
</template>

<style scoped>
.composer-editor :deep(.ProseMirror) {
  box-sizing: border-box;
  display: block;
  width: 100%;
  min-height: 59px;
  max-height: 180px;
  padding: 9px 11px;
  overflow: auto;
  resize: vertical;
  color: var(--ui-text);
  background: var(--ui-fill);
  border: 1px solid var(--ui-line);
  border-radius: 6px;
  font-size: var(--ui-font-content);
  line-height: var(--ui-line-content);
  overflow-wrap: anywhere;
}
.composer-editor :deep(.ProseMirror:focus-visible) {
  outline: none;
  border-color: var(--ui-focus);
}
.composer-editor :deep(.ProseMirror[aria-disabled="true"]) {
  opacity: 0.65;
}
.composer-editor :deep(.composer-editor-empty)::before {
  position: absolute;
  color: var(--ui-muted);
  content: attr(data-placeholder);
  pointer-events: none;
}
.composer-editor :deep(.composer-attachment-node) {
  display: inline-block;
  max-width: 100%;
  margin: 2px 4px 2px 0;
  vertical-align: middle;
  cursor: default;
  user-select: all;
  white-space: normal;
}
.composer-editor
  :deep(.ProseMirror[aria-disabled="true"] .composer-file-remove) {
  display: none;
}
.composer-editor-desktop :deep(.ProseMirror) {
  min-height: 76px;
  padding: 2px 0;
  border: 0;
  border-radius: 0;
  background: transparent;
}
@media (max-width: 760px) {
  .composer-editor :deep(.ProseMirror) {
    min-height: 48px;
    font-size: 1rem;
  }
}
</style>
