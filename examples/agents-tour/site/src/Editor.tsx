/**
 * @module
 * The Monaco editor: one model per lesson file, the SDK's real type
 * declarations as a virtual `node_modules`, and the tour's key commands.
 */
import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import TsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import type { CodeTarget } from "../../shared/links.ts";
import type { Diagnostic } from "../../shared/problems.ts";
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
  // Replaces a file's text as one edit, so undo still works.
  replace(name: string, content: string): void;
  // Shows a file's line in the middle and flashes the token at the target.
  reveal(target: CodeTarget): void;
  // The errors TypeScript finds in every file of the page, current as of
  // the text now in the editor.
  problems(): Promise<Diagnostic[]>;
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
  markers: Marker[];
  handlers: () => Handlers;
  onChange: (name: string, content: string) => void;
}

let typesAdded = false;

const compilerOptions = (): monaco.languages.typescript.CompilerOptions => {
  return {
    target: monaco.languages.typescript.ScriptTarget.ES2020,
    module: monaco.languages.typescript.ModuleKind.ESNext,
    moduleResolution: 100 as monaco.languages.typescript.ModuleResolutionKind,
    lib: ["es2023", "dom"],
    strict: true,
    noEmit: true,
    allowNonTsExtensions: true,
    skipLibCheck: true,
  };
};

export const addTypes = (files: Record<string, string>) => {
  if (typesAdded) {
    return;
  }

  typesAdded = true;

  const ts = monaco.languages.typescript.typescriptDefaults;

  ts.setEagerModelSync(true);
  ts.setCompilerOptions(compilerOptions());

  for (const [path, content] of Object.entries(files)) {
    ts.addExtraLib(content, path);
  }
};

const defineTheme = () => {
  monaco.editor.defineTheme("tour-dark", {
    base: "vs-dark",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": "#14161c",
      "editorLineNumber.foreground": "#4b5263",
      "editor.lineHighlightBackground": "#1b1e26",
    },
  });
};

type MessageChain = string | { messageText: string; next?: MessageChain[] };

const flatten = (text: MessageChain): string => {
  if (typeof text === "string") {
    return text;
  }

  return [text.messageText, ...(text.next ?? []).map(flatten)].join("\n");
};

const uriOf = (name: string) => {
  return monaco.Uri.parse(`file:///lesson/${name}`);
};

export const Editor = forwardRef<EditorApi, Props>(function Editor(props, ref) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const latest = useRef(props);
  const flash = useRef<monaco.editor.IEditorDecorationsCollection | null>(null);
  const flashTimer = useRef(0);

  latest.current = props;

  useImperativeHandle(ref, () => {
    return {
      focus: () => {
        editor.current?.focus();
      },
      hasFocus: () => {
        return Boolean(editor.current?.hasTextFocus());
      },
      replace: (name, content) => {
        const model = monaco.editor.getModel(uriOf(name));

        if (model && model.getValue() !== content) {
          model.pushEditOperations(
            [],
            [{ range: model.getFullModelRange(), text: content }],
            () => null,
          );
        }
      },
      reveal: (target) => {
        const model = monaco.editor.getModel(uriOf(target.file));
        const shown = editor.current;

        if (!model || !shown) {
          return;
        }

        if (shown.getModel() !== model) {
          shown.setModel(model);
          shown.updateOptions({
            readOnly: !latest.current.files.find((file) => {
              return file.name === target.file;
            })?.editable,
          });
        }

        const range = new monaco.Range(
          target.line,
          target.column,
          target.line,
          target.column + target.length,
        );

        shown.revealLineInCenter(target.line);
        shown.setSelection(range);
        flash.current?.clear();
        flash.current = shown.createDecorationsCollection([
          { range, options: { inlineClassName: "code-link-flash" } },
        ]);
        window.clearTimeout(flashTimer.current);
        flashTimer.current = window.setTimeout(() => {
          flash.current?.clear();
        }, 1800);
      },
      problems: async () => {
        const models = latest.current.files.flatMap((file) => {
          const model = monaco.editor.getModel(uriOf(file.name));

          return model ? [{ name: file.name, model }] : [];
        });

        // Monaco's own markers trail an edit by half a second. Asking the TS
        // worker directly gives the same checks, current at once.
        const fromWorker = async (): Promise<Diagnostic[]> => {
          const getWorker =
            await monaco.languages.typescript.getTypeScriptWorker();
          const worker = await getWorker(...models.map((one) => one.model.uri));
          const out: Diagnostic[] = [];

          for (const { name, model } of models) {
            const uri = model.uri.toString();
            const found = [
              ...(await worker.getSyntacticDiagnostics(uri)),
              ...(await worker.getSemanticDiagnostics(uri)),
            ];

            for (const one of found) {
              if (one.category !== 1 || one.start === undefined) {
                continue;
              }

              const at = model.getPositionAt(one.start);

              out.push({
                file: name,
                line: at.lineNumber,
                column: at.column,
                length: one.length ?? 0,
                code: one.code,
                message: flatten(one.messageText),
              });
            }
          }

          return out;
        };
        const fromMarkers = (): Diagnostic[] => {
          return models.flatMap(({ name, model }) => {
            return monaco.editor
              .getModelMarkers({ resource: model.uri })
              .filter(
                (marker) => marker.severity === monaco.MarkerSeverity.Error,
              )
              .map((marker) => {
                return {
                  file: name,
                  line: marker.startLineNumber,
                  column: marker.startColumn,
                  length: Math.max(0, marker.endColumn - marker.startColumn),
                  code: Number(
                    typeof marker.code === "object"
                      ? marker.code.value
                      : (marker.code ?? 0),
                  ),
                  message: marker.message,
                };
              });
          });
        };

        // If the worker is slow, the markers are the best there is.
        return Promise.race([
          fromWorker().catch(fromMarkers),
          new Promise<Diagnostic[]>((resolve) => {
            window.setTimeout(() => resolve(fromMarkers()), 300);
          }),
        ]);
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
    defineTheme();

    const created = monaco.editor.create(host.current as HTMLElement, {
      model: null,
      theme: "tour-dark",
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

    // Each model is validated the moment it is created, before its siblings
    // exist, so `./setup` would be reported missing until the next edit.
    // Re-applying the options revalidates every model now that all exist.
    monaco.languages.typescript.typescriptDefaults.setCompilerOptions(
      compilerOptions(),
    );

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
