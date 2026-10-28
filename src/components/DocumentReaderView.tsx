import { Component, lazy, Suspense, type ReactNode } from "react";
import { ReaderView } from "./ReaderView";
import type { DocumentPayload } from "../documents/core";
import { api } from "../api";
import { exportDocument } from "../documents/client";
const PdfReader = lazy(() => import("./PdfReader"));
class PdfBoundary extends Component<
  {
    children: ReactNode;
    payload: DocumentPayload;
    title: string;
    docKey: string;
    onClose?: () => void;
  },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (!this.state.failed) return this.props.children;
    const [p, b, ...parts] = this.props.docKey.split("/");
    return (
      <div className="reader">
        <div className="document-notice">
          <p>当前系统暂时无法显示内嵌 PDF，原件与已提取文字仍保留。</p>
          <button
            className="btn"
            onClick={() =>
              void api.docOpenExternal(
                p,
                b,
                this.props.payload.attachment!.original.path,
                this.props.payload.scope,
              )
            }
          >
            用系统阅读器打开
          </button>
          <button
            className="btn"
            onClick={() =>
              void exportDocument(p, b, parts.join("/"), this.props.title)
            }
          >
            导出 PDF 原件
          </button>
          {this.props.onClose && (
            <button className="btn" onClick={this.props.onClose}>
              关闭
            </button>
          )}
        </div>
        <ReaderView
          title={this.props.title}
          docKey={this.props.docKey}
          markdown={this.props.payload.markdown}
        />
      </div>
    );
  }
}
export function DocumentReaderView({
  payload,
  ...props
}: {
  payload: DocumentPayload;
  title: string;
  docKey: string;
  onClose?: () => void;
  standalone?: boolean;
  guessMath?: boolean;
  platform?: string;
}) {
  return payload.attachment?.kind === "pdf" ? (
    <PdfBoundary key={props.docKey} payload={payload} {...props}>
      <Suspense
        fallback={<div className="reader-splash">正在准备 PDF 阅读器…</div>}
      >
        <PdfReader payload={payload} {...props} />
      </Suspense>
    </PdfBoundary>
  ) : (
    <ReaderView
      {...props}
      markdown={payload.markdown}
      attachment={payload.attachment}
      scope={payload.scope}
    />
  );
}
