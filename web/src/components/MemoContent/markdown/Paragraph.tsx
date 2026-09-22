import type { Element } from "hast";
import { cn } from "@/lib/utils";
import LinkMetadataCard from "../LinkMetadataCard";
import { useMarkdownRenderContext } from "../MarkdownRenderContext";
import type { ReactMarkdownProps } from "./types";

interface ParagraphProps extends React.HTMLAttributes<HTMLParagraphElement>, ReactMarkdownProps {
  children: React.ReactNode;
}

function getSingleLinkHref(node?: Element): string | undefined {
  if (!node || node.tagName !== "p") {
    return undefined;
  }

  const meaningfulChildren = node.children.filter((child) => {
    return !(child.type === "text" && child.value.trim() === "");
  });

  if (meaningfulChildren.length !== 1) {
    return undefined;
  }

  const onlyChild = meaningfulChildren[0];
  if (onlyChild.type !== "element" || onlyChild.tagName !== "a") {
    return undefined;
  }

  const href = onlyChild.properties?.href;
  return typeof href === "string" ? href : undefined;
}

export const Paragraph = ({ children, className, node, ...props }: ParagraphProps) => {
  const { blockDepth } = useMarkdownRenderContext();
  const href = blockDepth === 0 ? getSingleLinkHref(node) : undefined;
  const paragraph = (
    <p className={cn("my-0 mb-2 leading-6", className)} {...props}>
      {children}
    </p>
  );

  if (href) {
    return <LinkMetadataCard url={href} fallback={paragraph} />;
  }

  return paragraph;
};
