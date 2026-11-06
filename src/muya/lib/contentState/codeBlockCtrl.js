import { loadLanguage } from '../prism/index'
import { escapeHTML } from '../utils'
// import resizeCodeBlockLineNumber from '../utils/resizeCodeLineNumber'
import selection from '../selection'

const CODE_UPDATE_REP = /^`{3,}(.*)/
const isMermaid = lang => /^mermaid(?:\s|$)/i.test(lang.trim())

const codeBlockCtrl = ContentState => {
  /**
   * Kick off async prism language loading and re-render once a brand-new
   * grammar lands. partialRender runs synchronously before the dynamic
   * import resolves; without this hop, the first render after typing the
   * fence shows raw text and only a later edit triggers highlighting.
   */
  ContentState.prototype.loadAndRehighlightLanguage = function (lang) {
    loadLanguage(lang)
      .then(infoList => {
        if (!Array.isArray(infoList)) return
        if (infoList.some(({ status }) => status === 'loaded')) {
          this.render()
        }
      })
      .catch(err => {
        console.warn('[muya] loadLanguage failed for', lang, err)
      })
  }

  /**
  * check edit language
  */
  ContentState.prototype.checkEditLanguage = function () {
    const { start } = selection.getCursorRange()
    if (!start) {
      return { lang: '', paragraph: null }
    }
    const startBlock = this.getBlock(start.key)
    const paragraph = document.querySelector(`#${start.key}`)
    let lang = ''
    const { text } = startBlock
    if (startBlock.type === 'span') {
      if (startBlock.functionType === 'languageInput') {
        lang = text.trim()
      } else if (startBlock.functionType === 'paragraphContent') {
        const token = text.match(/(^`{3,})([^`]+)/)
        if (token) {
          const len = token[1].length
          if (start.offset >= len) {
            lang = token[2].trim()
          }
        }
      }
    }
    return { lang, paragraph }
  }

  ContentState.prototype.selectLanguage = function (paragraph, lang) {
    const block = this.getBlock(paragraph.id)
    if (lang === 'math' && this.isGitlabCompatibilityEnabled && this.updateMathBlock(block)) {
      return
    }
    this.updateCodeLanguage(block, lang)
  }

  /**
   * Update the code block language or creates a new code block.
   *
   * @param block Language-input block or paragraph
   * @param lang Language identifier
   */
  ContentState.prototype.updateCodeLanguage = function (block, lang) {
    if (!lang || typeof lang !== 'string') {
      console.error('Invalid code block language string:', lang)

      // Use fallback language
      lang = ''
    }

    if (block.functionType === 'languageInput' && isMermaid(lang)) {
      const preBlock = this.getParent(block)
      const source = this.getNextSibling(block).children[0].text
      delete preBlock.lang
      const codeContent = this.initContainerBlock('mermaid', preBlock)
      codeContent.text = source
      const { key } = codeContent
      this.cursor = { start: { key, offset: 0 }, end: { key, offset: 0 } }
      return this.partialRender()
    }

    // Prevent possible XSS on language input when using lang attribute later on. The input is also sanitized before rendering.
    lang = escapeHTML(lang)

    if (block.functionType === 'languageInput') {
      if (lang) this.loadAndRehighlightLanguage(lang)
      const preBlock = this.getParent(block)
      const nextSibling = this.getNextSibling(block)

      // Only update code language if necessary
      if (block.text !== lang || preBlock.text !== lang || nextSibling.text !== lang) {
        block.text = lang
        preBlock.lang = lang
        preBlock.functionType = 'fencecode'
        nextSibling.lang = lang
        nextSibling.children.forEach(c => (c.lang = lang))
      }

      // Set cursor at the first line
      const { key } = nextSibling.children[0]
      const offset = 0
      this.cursor = {
        start: { key, offset },
        end: { key, offset }
      }
    } else {
      block.text = block.text.replace(/^(`+)([^`]+$)/g, `$1${lang}`)
      this.codeBlockUpdate(block)
    }
    this.partialRender()
  }

  /**
   * Convert an opening fence and return the editable block to focus.
   */
  ContentState.prototype.codeBlockUpdate = function (block, code = '', lang) {
    if (block.type === 'span') {
      block = this.getParent(block)
    }
    // If it's not a p block, no need to update
    if (block.type !== 'p') return false
    // If p block's children are more than one, no need to update
    if (block.children.length !== 1) return false

    const { text } = block.children[0]
    const match = CODE_UPDATE_REP.exec(text)
    if (match || lang) {
      const language = lang || (match ? match[1] : '')
      if (isMermaid(language)) {
        const codeContent = this.initContainerBlock('mermaid', block)
        codeContent.text = code
        const { key } = codeContent
        const offset = code.length
        this.cursor = { start: { key, offset }, end: { key, offset } }
        return codeContent
      }
      const codeBlock = this.createBlock('code', {
        lang: language
      })
      const codeContent = this.createBlock('span', {
        text: code,
        lang: language,
        functionType: 'codeContent'
      })
      const inputBlock = this.createBlock('span', {
        text: language,
        functionType: 'languageInput'
      })

      if (language) {
        this.loadAndRehighlightLanguage(language)
      }

      block.type = 'pre'
      block.functionType = 'fencecode'
      block.lang = language
      block.text = ''
      block.history = null
      block.children = []

      this.appendChild(codeBlock, codeContent)
      this.appendChild(block, inputBlock)
      this.appendChild(block, codeBlock)
      const { key } = codeContent
      const offset = code.length
      this.cursor = {
        start: { key, offset },
        end: { key, offset }
      }
      return inputBlock
    }
    return false
  }

  /**
   * Copy the code block by click right-top copy icon in code block.
   */
  ContentState.prototype.copyCodeBlock = async function (event) {
    const { target } = event
    const preEle = target.closest('pre')
    const preBlock = this.getBlock(preEle.id)
    const codeBlock = preBlock.children.find(c => c.type === 'code')
    const codeContent = codeBlock.children[0].text

    const { clipboardWriteText } = this.muya.options
    if (typeof clipboardWriteText === 'function') {
      try {
        await clipboardWriteText(codeContent)
        return
      } catch (err) {
        console.warn('[muya] clipboardWriteText failed, falling back to copy event', err)
      }
    }

    this.muya.clipboard.copy('copyCodeContent', codeContent)
  }

  ContentState.prototype.resizeLineNumber = function () {
    // FIXME: Disabled due to #1648.
    // const { codeBlockLineNumbers } = this.muya.options
    // if (!codeBlockLineNumbers) {
    //   return
    // }

    // const codeBlocks = document.querySelectorAll('pre.line-numbers')
    // if (codeBlocks.length) {
    //   for (const ele of codeBlocks) {
    //     resizeCodeBlockLineNumber(ele)
    //   }
    // }
  }
}

export default codeBlockCtrl
