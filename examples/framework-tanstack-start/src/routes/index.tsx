import { createFileRoute } from '@tanstack/react-router'
import { createServerFn } from "@tanstack/react-start"
import { inngest } from "../inngest/client"


export const helloWorld = createServerFn().handler(async () => { 
  return inngest.send({
    name: 'demo/event.sent',
    data: {
      message: 'Hello World',
    },
  })
}) 

export const Route = createFileRoute('/')({
  component: Home,
})

function Home() {
  return (
    <div className="p-2">
      <h3>Welcome Home!!!</h3>
      <button className="bg-blue-500 text-white px-2 py-1 rounded uppercase font-black text-sm" onClick={() => helloWorld()}>Send Event!</button>
    </div>
  )
}
