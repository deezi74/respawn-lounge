import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/NotFound";
import { Route, Switch } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import Home from "./pages/Home";
export default function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider defaultTheme="dark">
        <TooltipProvider>
          <Toaster position="bottom-center" theme="dark" />
          <Switch>
            {[
              "/",
              "/tray",
              "/lounges",
              "/squads",
              "/studio",
              "/settings",
              "/profile",
              "/watch/:id",
              "/clip/:id",
              "/invite/:id",
              "/post/:id",
            ].map(path => (
              <Route key={path} path={path} component={Home} />
            ))}
            <Route path="/404" component={NotFound} />
            <Route component={NotFound} />
          </Switch>
        </TooltipProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}
