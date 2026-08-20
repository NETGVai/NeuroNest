import { init } from './modern-monaco/index.mjs';
import { neuronestThemes, offlineGrammars } from './modern-monaco-offline.mjs';

const themeNames = {
  dark: 'neuronest-dark',
  light: 'neuronest-light',
  midnight: 'neuronest-midnight',
  sepia: 'neuronest-sepia',
  terminal: 'neuronest-terminal',
  zen: 'neuronest-zen',
};

export async function initializeModernMonaco() {
  const defaultTheme = neuronestThemes.find((theme) => theme.name === 'neuronest-dark');
  const monaco = await init({
    defaultTheme,
    themes: neuronestThemes.filter((theme) => theme !== defaultTheme),
    langs: offlineGrammars,
  });

  globalThis.monaco = monaco;

  // modern-monaco's local language servers provide IntelliSense for the
  // supported web languages. Keep this compatibility configuration for any
  // Monaco language defaults exposed by the editor-core build.
  try {
    const typescript = monaco.languages?.typescript;
    if (typescript?.typescriptDefaults) {
      typescript.typescriptDefaults.setCompilerOptions({
        target: typescript.ScriptTarget.ESNext,
        module: typescript.ModuleKind.ESNext,
        allowNonTsExtensions: true,
        allowJs: true,
        checkJs: true,
        strict: true,
        jsx: typescript.JsxEmit.React,
        esModuleInterop: true,
      });
      typescript.typescriptDefaults.setDiagnosticsOptions({
        noSemanticValidation: false,
        noSyntaxValidation: false,
      });
      typescript.javascriptDefaults.setDiagnosticsOptions({
        noSemanticValidation: false,
        noSyntaxValidation: false,
      });
    }
    monaco.languages?.json?.jsonDefaults?.setDiagnosticsOptions({
      validate: true,
      allowComments: true,
    });
  } catch (error) {
    console.warn('[Monaco] Optional IntelliSense compatibility config failed:', error);
  }

  const savedTheme = localStorage.getItem('neuronest-theme') || 'dark';
  const theme = themeNames[savedTheme] || themeNames.dark;
  monaco.editor.setTheme(theme);
  console.log('[Monaco] modern-monaco initialized with local Shiki assets:', theme);
  return monaco;
}
