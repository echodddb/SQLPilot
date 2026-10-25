<template>
  <div class="modal-mask" @click.self="emit('close')">
    <div class="pm">
      <div class="pm-head">
        <span class="pm-title">终端偏好</span>
        <span class="pm-sub">全局默认值；会话里可单独覆盖配色/字号/编码</span>
        <span style="flex:1"></span>
        <button class="pm-x" @click="emit('close')">✕</button>
      </div>

      <div class="pm-body">
        <div class="pm-sec">
          <div class="pm-sec-t">外观</div>

          <div class="pm-row">
            <span class="pm-label">配色方案</span>
            <div class="pm-schemes">
              <button
                v-for="s in TERM_SCHEMES"
                :key="s.id"
                class="pm-scheme"
                :class="{ on: draft.scheme === s.id }"
                @click="draft.scheme = s.id"
              >
                <span class="pm-swatch" :style="swatchStyle(s.id)"></span>
                <span class="pm-scheme-name">{{ s.name }}</span>
              </button>
            </div>
          </div>

          <div class="pm-row">
            <span class="pm-label">字体</span>
            <select v-model="draft.fontFamily" class="pm-sel">
              <option v-for="f in FONT_STACKS" :key="f.value" :value="f.value">{{ f.name }}</option>
            </select>
            <span class="pm-label" style="margin-left:14px">字号</span>
            <select v-model.number="draft.fontSize" class="pm-sel" style="width:90px">
              <option v-for="n in FONT_SIZES" :key="n" :value="n">{{ n }}px</option>
            </select>
            <span class="pm-label" style="margin-left:14px">行高</span>
            <select v-model.number="draft.lineHeight" class="pm-sel" style="width:90px">
              <option v-for="n in [1, 1.1, 1.2, 1.3, 1.4, 1.5]" :key="n" :value="n">{{ n }}</option>
            </select>
          </div>

          <div class="pm-row">
            <span class="pm-label">光标</span>
            <select v-model="draft.cursorStyle" class="pm-sel" style="width:110px">
              <option value="block">方块</option>
              <option value="bar">竖线</option>
              <option value="underline">下划线</option>
            </select>
            <label class="pm-chk"><input type="checkbox" v-model="draft.cursorBlink" /> 闪烁</label>
            <span class="pm-label" style="margin-left:14px">回滚行数</span>
            <input v-model.number="draft.scrollback" type="number" min="200" max="200000" step="500" class="pm-num" />
          </div>

          <div class="pm-preview" :style="previewStyle">
            <div class="pm-preview-line">
              <span style="color:#3fb950">oracle@db01</span><span>:~$</span> ls -l /u01/app
            </div>
            <div class="pm-preview-line">
              <span style="color:#4184e4">drwxr-xr-x</span> 2 oracle oinstall 4096 Oct 24 10:30 <span style="color:#4184e4">oracle</span>
            </div>
            <div class="pm-preview-line">
              <span style="color:#e5534b">total 12</span> · <span style="color:#c69026">UTF-8 中文预览</span>
            </div>
          </div>
        </div>

        <div class="pm-sec">
          <div class="pm-sec-t">交互</div>
          <label class="pm-chk"><input type="checkbox" v-model="draft.copyOnSelect" /> 选中即复制</label>
          <label class="pm-chk"><input type="checkbox" v-model="draft.rightClickPaste" /> 右键直接粘贴（关闭时弹出菜单）</label>
          <label class="pm-chk"><input type="checkbox" v-model="draft.confirmMultilinePaste" /> 多行粘贴前二次确认（防误执行）</label>

          <div class="pm-row" style="margin-top:10px">
            <span class="pm-label">默认编码</span>
            <select v-model="draft.encoding" class="pm-sel" style="width:220px">
              <option v-for="e in ENCODINGS" :key="e.id" :value="e.id">{{ e.name }} — {{ e.hint }}</option>
            </select>
          </div>
        </div>
      </div>

      <div class="pm-foot">
        <button class="pm-btn" @click="reset">恢复默认</button>
        <span style="flex:1"></span>
        <button class="pm-btn" @click="emit('close')">取消</button>
        <button class="pm-btn primary" :disabled="saving" @click="save">{{ saving ? '保存中…' : '保存' }}</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import type { TermPrefs, TermScheme } from '../../../main/types'
import { ENCODINGS, FALLBACK_PREFS, FONT_SIZES, FONT_STACKS, saveTermPrefs, termPrefs } from '../../server/prefs'
import { TERM_SCHEMES, themeFor } from '../../server/schemes'
import { flash } from '../../server/state'

const emit = defineEmits<{ (e: 'close'): void; (e: 'saved'): void }>()

const draft = reactive<TermPrefs>({ ...termPrefs() })
const saving = ref(false)

function isLight(): boolean {
  return document.documentElement.getAttribute('data-theme') === 'light'
}

function swatchStyle(id: TermScheme): Record<string, string> {
  const t = themeFor(id, isLight())
  return {
    background: t.background || 'transparent',
    borderColor: t.foreground || 'transparent',
    boxShadow: `inset 0 -7px 0 0 ${t.green || '#3fb950'}, inset 0 -14px 0 0 ${t.blue || '#4184e4'}`
  }
}

const previewStyle = computed(() => {
  const t = themeFor(draft.scheme, isLight())
  return {
    background: t.background || 'var(--bg-code)',
    color: t.foreground || 'var(--text)',
    fontFamily: draft.fontFamily,
    fontSize: draft.fontSize + 'px',
    lineHeight: String(draft.lineHeight)
  }
})

function reset(): void {
  Object.assign(draft, FALLBACK_PREFS)
}

async function save(): Promise<void> {
  saving.value = true
  const r = await saveTermPrefs({ ...draft })
  saving.value = false
  if (!r.ok) {
    await window.sqlpilot.uiAlert('保存失败：' + (r.error || ''))
    return
  }
  flash('终端偏好已保存')
  emit('saved')
  emit('close')
}
</script>

<style scoped>
.pm {
  width: 760px; max-width: 94vw; max-height: 88vh; display: flex; flex-direction: column;
  background: var(--bg-card); border: 1px solid var(--border-strong);
  border-radius: 12px; box-shadow: var(--shadow-lg); overflow: hidden;
}
.pm-head { display: flex; align-items: center; gap: 10px; padding: 12px 16px; border-bottom: 1px solid var(--border); }
.pm-title { font-size: 14px; font-weight: 600; color: var(--text); }
.pm-sub { font-size: 11.5px; color: var(--text-faint); }
.pm-x { border: none; background: none; color: var(--text-faint); cursor: pointer; font-size: 13px; font-family: inherit; }
.pm-x:hover { color: var(--red); }
.pm-body { flex: 1; overflow-y: auto; padding: 14px 16px; }
.pm-sec { margin-bottom: 18px; }
.pm-sec-t {
  font-size: 11px; font-weight: 700; color: var(--text-faint);
  letter-spacing: 1px; margin-bottom: 10px; padding-bottom: 4px; border-bottom: 1px solid var(--border);
}
.pm-row { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-bottom: 10px; }
.pm-label { font-size: 12px; color: var(--text-dim); }
.pm-sel, .pm-num { font-size: 12px; padding: 4px 8px; border-radius: 7px; }
.pm-num { width: 100px; }
.pm-chk { display: flex; align-items: center; gap: 6px; font-size: 12.5px; color: var(--text-dim); cursor: pointer; margin: 5px 16px 5px 0; }
.pm-schemes { display: flex; flex-wrap: wrap; gap: 6px; }
.pm-scheme {
  display: flex; align-items: center; gap: 7px; padding: 4px 9px 4px 5px;
  border: 1px solid var(--border); background: var(--bg-side); border-radius: 8px;
  cursor: pointer; font-family: inherit; color: var(--text-dim); font-size: 11.5px;
}
.pm-scheme:hover { border-color: var(--border-strong); color: var(--text); }
.pm-scheme.on { border-color: var(--accent); color: var(--accent); background: var(--accent-dim); }
.pm-swatch { width: 22px; height: 16px; border-radius: 4px; border: 1px solid; display: inline-block; }
.pm-preview { margin-top: 10px; padding: 10px 12px; border-radius: 8px; border: 1px solid var(--border); overflow: hidden; }
.pm-preview-line { white-space: nowrap; font-family: var(--mono); }
.pm-foot { display: flex; align-items: center; gap: 8px; padding: 11px 16px; border-top: 1px solid var(--border); }
.pm-btn {
  border: 1px solid var(--border); background: var(--bg-side); color: var(--text-dim);
  border-radius: 7px; padding: 5px 15px; font-size: 12.5px; cursor: pointer; font-family: inherit;
}
.pm-btn:hover:not(:disabled) { color: var(--text); border-color: var(--border-strong); }
.pm-btn:disabled { opacity: .5; cursor: default; }
.pm-btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
</style>
