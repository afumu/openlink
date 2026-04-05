<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { NButton, NInput, NList, NListItem, NTag, NSpace, NCard, NDivider, useMessage } from 'naive-ui'
import { Add20Filled, Checkmark20Filled } from '@vicons/fluent'
interface Task {

id: string

content: string

status: 'pending' | 'done'

priority: 'high' | 'medium' | 'low'

created: string

tags: string[]

}
const message = useMessage()

const tasks = ref<Task[]>([])

const newContent = ref('')
const pendingTasks = computed(() => tasks.value.filter(t => t.status === 'pending'))
const load = () => {

const raw = localStorage.getItem('matrix-todos')

if (raw) tasks.value = JSON.parse(raw)

}
const save = () => {

localStorage.setItem('matrix-todos', JSON.stringify(tasks.value))

}
const addTask = () => {

if (!newContent.value.trim()) return

tasks.value.unshift({

id: 'm' + Date.now(),

content: newContent.value.trim(),

status: 'pending',

priority: 'medium',

created: new Date().toISOString(),

tags: []

})

newContent.value = ''

save()

message.success('已添加')

}
const doneTask = (id: string) => {

const t = tasks.value.find(t => t.id === id)

if (t) {

t.status = 'done'

save()

message.success('已完成')

}

}
onMounted(load)

</script><template>
  <n-card title="Matrix 代办系统" style="max-width: 680px; margin: 40px auto;">
    <n-space vertical size="large">
      <n-space>
        <n-input v-model:value="newContent" placeholder="今天你要做什么？" style="flex:1" @keyup.enter="addTask" />
        <n-button type="primary" @click="addTask" :icon="() => h(Add20Filled)">添加</n-button>
      </n-space>



text

  <n-list v-if="pendingTasks.length">
    <n-list-item v-for="task in pendingTasks" :key="task.id">
      <n-space vertical size="small" style="width:100%">
        <n-space align="center" justify="space-between">
          <div>
            <n-tag :type="task.priority === 'high' ? 'error' : task.priority === 'medium' ? 'warning' : 'info'" round size="small">
              {{ task.priority }}
            </n-tag>
            <span style="margin-left:12px">{{ task.content }}</span>
          </div>
          <n-button size="small" type="success" circle @click="doneTask(task.id)" :icon="() => h(Checkmark20Filled)" />
        </n-space>
      </n-space>
    </n-list-item>
  </n-list>

  <div v-else style="text-align:center; color:#999; padding:60px 0">
    暂无任务，享受清净吧 ✨
  </div>
</n-space>  </n-card>
</template>
