// Preserve the old copy contract: text/paragraph boundaries survive; UI metadata does not.
export function copyMessageSelection(
  event: ClipboardEvent,
  container: HTMLElement,
) {
  const selection = window.getSelection(),
    active = document.activeElement as HTMLElement | null;
  if (
    event.defaultPrevented ||
    !event.clipboardData ||
    !selection ||
    selection.isCollapsed ||
    !selection.rangeCount ||
    active?.matches("input,textarea,select") ||
    active?.isContentEditable
  )
    return;
  const excluded = "small,time,button,.vue-message-sender,.avatar,input";
  const ranges = Array.from({ length: selection.rangeCount }, (_, index) =>
    selection.getRangeAt(index),
  );
  if (
    !ranges.every((range) => container.contains(range.commonAncestorContainer))
  )
    return;
  function selectedText(range: Range) {
    const root = range.commonAncestorContainer,
      chunks: { text?: string; gap?: number }[] = [];
    function visit(node: Node) {
      if (!range.intersectsNode(node)) return;
      if (node.nodeType === Node.TEXT_NODE) {
        if (
          node.parentElement &&
          getComputedStyle(node.parentElement).userSelect === "none"
        )
          return;
        const start = node === range.startContainer ? range.startOffset : 0,
          end =
            node === range.endContainer
              ? range.endOffset
              : (node as Text).length;
        chunks.push({ text: (node as Text).data.slice(start, end) });
        return;
      }
      if (
        node.nodeType !== Node.ELEMENT_NODE &&
        node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE
      )
        return;
      const element =
        node.nodeType === Node.ELEMENT_NODE ? (node as HTMLElement) : null;
      if (element?.matches(excluded + ",script,style,template,noscript"))
        return;
      const style = element ? getComputedStyle(element) : null;
      if (
        style?.display === "none" ||
        style?.visibility === "hidden" ||
        style?.visibility === "collapse"
      )
        return;
      if (element?.tagName === "BR") {
        chunks.push({ text: "\n" });
        return;
      }
      const block =
          element &&
          node !== root &&
          !["inline", "inline-block", "inline-flex", "contents"].includes(
            style!.display,
          ),
        gap = element?.tagName === "P" ? 2 : 1;
      if (block) chunks.push({ gap });
      for (const child of node.childNodes) visit(child);
      if (block) chunks.push({ gap });
    }
    visit(root);
    let text = "",
      pending = 0;
    for (const chunk of chunks) {
      if (chunk.gap) {
        pending = Math.max(pending, chunk.gap);
        continue;
      }
      if (!chunk.text) continue;
      if (text && pending)
        text += "\n".repeat(
          Math.max(0, pending - /\n*$/.exec(text)![0].length),
        );
      text += chunk.text;
      pending = 0;
    }
    return text;
  }
  const text = ranges.map(selectedText).filter(Boolean).join("\n");
  event.preventDefault();
  if (text) {
    event.clipboardData.clearData();
    event.clipboardData.setData("text/plain", text);
  }
}
