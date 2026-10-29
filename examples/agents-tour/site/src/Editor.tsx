/**
 * @module
 * The Monaco editor: one model per lesson file, the SDK's real type
 * declarations as a virtual `node_modules`, and the tour's key commands.
 */
import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import TsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import type { PageFile } from "../../shared/types.ts";
import { type Handlers, registerEditorCommands } from "./keyboard.tsx";

self.MonacoEnvironment = {
  getWorker: (_id, label) => {
    return label === "typescript" || label === "javascript"
      ? new TsWorker()
      : new EditorWorker();
  },
};

export interface EditorApi {
  focus(): void;
  hasFocus(): boolean;
  format(): Promise<void>;
  values(): Record<string, string>;
  setValue(name: string, content: string): void;
}

export interface Marker {
  file: string;
  line: number;
  message: string;
}

interface Props {
  files: PageFile[];
  active: string;
  dark: boolean;
  markers: Marker[];
  handlers: () => Handlers;
  onChange: (name: string, content: string) => void;
}

let typesAdded = false;

export const addTypes = (files: Record<string, string>) => {
  if (typesAdded) {
    return;
  }

  typesAdded = true;

  const ts = monaco.languages.typescript.typescriptDefaults;

  ts.setEagerModelSync(true);
  ts.setCompilerOptions({
    target: monaco.languages.typescript.ScriptTarget.ES2020,
    module: monaco.languages.typescript.ModuleKind.ESNext,
    moduleResolution: 100 as monaco.languages.typescript.ModuleResolutionKind,
    lib: ["es2023", "dom"],
    strict: true,
    noEmit: true,
    allowNonTsExtensions: true,
    skipLibCheck: true,
  });

  for (const [path, content] of Object.entries(files)) {
    ts.addExtraLib(content, path);
  }
};

const css = (name: string) => {
  return getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
};

const defineThemes = () => {
  const pick = (name: string, fallback: string) => {
    return css(name) || fallback;
  };

  for (const dark of [false, true]) {
    monaco.editor.defineTheme(dark ? "tour-dark" : "tour-light", {
      base: dark ? "vs-dark" : "vs",
      inherit: true,
      rules: [],
      colors: {
        "editor.background": dark ? "#14161c" : "#ffffff",
        "editorLineNumber.foreground": dark ? "#4b5263" : "#b4b9c4",
        "editor.lineHighlightBackground": dark ? "#1b1e26" : "#f5f6fa",
      },
    });
  }

  return pick;
};

const uriOf = (name: string) => {
  return monaco.Uri.parse(`file:///lesson/${name}`);
};

export const Editor = forwardRef<EditorApi, Props>(function Editor(props, ref) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const latest = useRef(props);

  latest.current = props;

  useImperativeHandle(ref, () => {
    return {
      focus: () => {
        editor.current?.focus();
      },
      hasFocus: () => {
        return Boolean(editor.current?.hasTextFocus());
      },
      format: async () => {
        await editor.current?.getAction("editor.action.formatDocument")?.run();
      },
      values: () => {
        const out: Record<string, string> = {};

        for (const file of latest.current.files) {
          out[file.name] =
            monaco.editor.getModel(uriOf(file.name))?.getValue() ??
            file.content;
        }

        return out;
      },
      setValue: (name, content) => {
        monaco.editor.getModel(uriOf(name))?.setValue(content);
      },
    };
  });

  useEffect(() => {
    defineThemes();

    const created = monaco.editor.create(host.current as HTMLElement, {
      model: null,
      automaticLayout: true,
      minimap: { enabled: false },
      fontSize: 14,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
      lineNumbersMinChars: 3,
      scrollBeyondLastLine: false,
      padding: { top: 12, bottom: 12 },
      renderLineHighlight: "line",
      tabSize: 2,
      ariaLabel: "Code editor",
      fixedOverflowWidgets: true,
    });

    editor.current = created;
    registerEditorCommands(monaco, created, () => {
      return latest.current.handlers();
    });

    return () => {
      created.dispose();
      editor.current = null;
    };
  }, []);

  // One model per file; a new page replaces them.
  useEffect(() => {
    const models = props.files.map((file) => {
      const uri = uriOf(file.name);
      const existing = monaco.editor.getModel(uri);

      existing?.dispose();

      const model = monaco.editor.createModel(file.content, "typescript", uri);

      model.onDidChangeContent(() => {
        latest.current.onChange(file.name, model.getValue());
      });

      return model;
    });

    return () => {
      for (const model of models) {
        model.dispose();
      }
    };
  }, [props.files]);

  useEffect(() => {
    const model = monaco.editor.getModel(uriOf(props.active));
    const file = props.files.find((candidate) => {
      return candidate.name === props.active;
    });

    if (model && editor.current) {
      editor.current.setModel(model);
      editor.current.updateOptions({ readOnly: !file?.editable });
    }
  }, [props.active, props.files]);

  useEffect(() => {
    monaco.editor.setTheme(props.dark ? "tour-dark" : "tour-light");
  }, [props.dark]);

  useEffect(() => {
    for (const file of props.files) {
      const model = monaco.editor.getModel(uriOf(file.name));

      if (model) {
        monaco.editor.setModelMarkers(
          model,
          "tour",
          props.markers
            .filter((marker) => {
              return marker.file === file.name;
            })
            .map((marker) => {
              return {
                severity: monaco.MarkerSeverity.Error,
                message: marker.message,
                startLineNumber: marker.line,
                endLineNumber: marker.line,
                startColumn: 1,
                endColumn: model.getLineMaxColumn(marker.line),
              };
            }),
        );
      }
    }
  }, [props.markers, props.files]);

  return <div className="editor-host" ref={host} />;
});

// Lets the browser tests read the editor's diagnostics.
(window as unknown as { __tourMonaco: typeof monaco }).__tourMonaco = monaco;
