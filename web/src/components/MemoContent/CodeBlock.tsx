import copy from "copy-to-clipboard";
import { CheckIcon, CopyIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { cn } from "@/lib/utils";
import { getThemeWithFallback, resolveTheme } from "@/utils/theme";
import { MermaidBlock } from "./MermaidBlock";
import type { ReactMarkdownProps } from "./markdown/types";
import { extractCodeContent, extractLanguage } from "./utils";

interface CodeBlockProps extends ReactMarkdownProps {
  children?: React.ReactNode;
  className?: string;
}

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return char;
    }
  });

export const CodeBlock = ({ children, className, node: _node, ...props }: CodeBlockProps) => {
  const { userGeneralSetting } = useAuth();
  const [copied, setCopied] = useState(false);

  const codeElement = children as React.ReactElement;
  const codeClassName = codeElement?.props?.className || "";
  const codeContent = extractCodeContent(children);
  const language = extractLanguage(codeClassName);
  const [highlightedCode, setHighlightedCode] = useState(() => escapeHtml(codeContent));

  // If it's a mermaid block, render with MermaidBlock component
  if (language === "mermaid") {
    return (
      <pre className="relative">
        <MermaidBlock className={cn(className)} {...props}>
          {children}
        </MermaidBlock>
      </pre>
    );
  }

  const theme = getThemeWithFallback(userGeneralSetting?.theme);
  const resolvedTheme = resolveTheme(theme);
  const isDarkTheme = resolvedTheme.includes("dark");

  // Dynamically load highlight.js theme based on app theme
  useEffect(() => {
    const dynamicImportStyle = async () => {
      // Remove any existing highlight.js style
      const existingStyle = document.querySelector("style[data-hljs-theme]");
      if (existingStyle) {
        existingStyle.remove();
      }

      try {
        const cssModule = isDarkTheme
          ? await import("highlight.js/styles/github-dark-dimmed.css?inline")
          : await import("highlight.js/styles/github.css?inline");

        // Create and inject the style
        const style = document.createElement("style");
        style.textContent = cssModule.default;
        style.setAttribute("data-hljs-theme", isDarkTheme ? "dark" : "light");
        document.head.appendChild(style);
      } catch (error) {
        console.warn("Failed to load highlight.js theme:", error);
      }
    };

    dynamicImportStyle();
  }, [resolvedTheme, isDarkTheme]);

  useEffect(() => {
    let cancelled = false;
    const fallback = escapeHtml(codeContent);

    if (!language) {
      setHighlightedCode(fallback);
      return;
    }

    import("highlight.js/lib/common")
      .then((module) => {
        const hljs = module.default;
        const lang = hljs.getLanguage(language);
        return lang ? hljs.highlight(codeContent, { language }).value : fallback;
      })
      .catch(() => fallback)
      .then((nextHighlightedCode) => {
        if (!cancelled) {
          setHighlightedCode(nextHighlightedCode);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [language, codeContent]);

  const handleCopy = async () => {
    try {
      // Try native clipboard API first (requires HTTPS or localhost)
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(codeContent);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } else {
        // Fallback to copy-to-clipboard library for non-secure contexts
        const success = copy(codeContent);
        if (success) {
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        } else {
          console.error("Failed to copy code");
        }
      }
    } catch (err) {
      // If native API fails, try fallback
      console.warn("Native clipboard failed, using fallback:", err);
      const success = copy(codeContent);
      if (success) {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } else {
        console.error("Failed to copy code:", err);
      }
    }
  };

  return (
    <pre className="relative my-2 rounded-lg border border-border bg-muted/20 overflow-hidden">
      {/* Header with language label and copy button */}
      <div className="flex items-center justify-between px-2 py-1 border-b border-border bg-muted/30">
        <span className="text-xs text-foreground select-none">{language || "text"}</span>
        <button
          onClick={handleCopy}
          className={cn(
            "inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs",
            "transition-colors duration-200",
            "hover:bg-accent active:scale-95",
            copied ? "text-primary" : "text-muted-foreground hover:text-foreground",
          )}
          aria-label={copied ? "Copied" : "Copy code"}
          title={copied ? "Copied!" : "Copy code"}
        >
          {copied ? (
            <>
              <CheckIcon className="w-3.5 h-3.5" />
              <span>Copied</span>
            </>
          ) : (
            <>
              <CopyIcon className="w-3.5 h-3.5" />
              <span>Copy</span>
            </>
          )}
        </button>
      </div>

      {/* Code content */}
      <div className="overflow-x-auto">
        <code
          className={cn("block px-3 py-2 text-sm leading-relaxed", `language-${language}`)}
          dangerouslySetInnerHTML={{ __html: highlightedCode }}
        />
      </div>
    </pre>
  );
};
