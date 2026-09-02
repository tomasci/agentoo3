import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import styles from './markdown.module.scss'

/**
 * Agent output is markdown — headings, tables, fenced code — and was being shown
 * as plain text, so a reply came out as a wall of `#` and `|`.
 *
 * react-markdown does not render raw HTML unless a plugin is added to allow it,
 * which is the property that matters here: the text comes from a model and from
 * files in the repository, so it is not something to hand to `innerHTML`.
 * remark-gfm adds the parts of GitHub's dialect that actually show up in this
 * output — tables above all, plus task lists and strikethrough.
 */
export function Markdown({ children, compact = false }: { children: string; compact?: boolean }) {
  return (
    <div className={`${styles.markdown} ${compact ? styles.compact : ''}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // Anything linked here is external to the app, and a transcript should
          // not be able to navigate the session away from itself.
          // `node` is react-markdown's mdast node. It is not a DOM attribute,
          // and spreading it through renders node="[object Object]" on the tag,
          // so it is dropped from both overrides below.
          a: ({ children: text, node: _node, ...props }) => (
            <a {...props} target="_blank" rel="noopener noreferrer">
              {text}
            </a>
          ),
          // Wrap wide tables rather than letting them push the page sideways.
          table: ({ children: rows, node: _node, ...props }) => (
            <div className={styles.tableWrap}>
              <table {...props}>{rows}</table>
            </div>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  )
}
