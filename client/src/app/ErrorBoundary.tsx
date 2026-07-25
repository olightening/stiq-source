import React from 'react';
import {SafeAreaView, ScrollView, StyleSheet, Text} from 'react-native';
import {Press} from '../ui/Press';
import {log} from '../util/log';

interface Props {
  children: React.ReactNode;
  /** Labels this boundary in the local crash record (e.g. "thread-detail", "dm-conversation") so a
   *  nested surface's crash can be told apart from the root boundary's. Defaults to 'root'. */
  scope?: string;
  /** Called in addition to clearing local error state when the user taps "Try again" — lets the
   *  host reset whatever state led to the crash (e.g. close the overlay that broke). */
  onReset?: () => void;
}

interface State {
  error: Error | null;
}

// Keep the recorded stacks short: this is a debugging breadcrumb in a bounded in-memory ring
// (see util/log.ts), not a full report — a few lines is enough to identify where a render broke.
const STACK_HEAD_LINES = 5;

/** First few lines of a stack trace/componentStack. Never touches disk or network — purely local. */
function headLines(text: string | null | undefined, n: number): string {
  if (!text) return '';
  return text.split('\n').slice(0, n).join('\n');
}

export class ErrorBoundary extends React.Component<Props, State> {
  override state: State = {error: null};

  static getDerivedStateFromError(error: Error): State {
    return {error};
  }

  override componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // Memory-only ring buffer (util/log.ts) — never leaves the device, so recording this stays
    // privacy-correct for an anonymous app: it's local debugging context only.
    log.error('boundary', {
      scope: this.props.scope ?? 'root',
      message: error.message,
      stack: headLines(error.stack, STACK_HEAD_LINES),
      componentStack: headLines(info.componentStack, STACK_HEAD_LINES),
      ts: Date.now(),
    });
  }

  private reset = (): void => {
    this.setState({error: null});
    this.props.onReset?.();
  };

  override render() {
    if (this.state.error) {
      return (
        <SafeAreaView style={s.root}>
          <ScrollView contentContainerStyle={s.scroll}>
            <Text style={s.title}>Something went wrong</Text>
            <Text style={s.msg}>{this.state.error.message}</Text>
            <Text style={s.stack}>{this.state.error.stack}</Text>
            <Press style={s.btn} onPress={this.reset}>
              <Text style={s.btnText}>Try again</Text>
            </Press>
          </ScrollView>
        </SafeAreaView>
      );
    }
    return this.props.children;
  }
}

const s = StyleSheet.create({
  root: {flex: 1, backgroundColor: '#0b0b0b'},
  scroll: {padding: 20, flexGrow: 1},
  title: {fontSize: 18, fontWeight: '700', color: '#d45', marginBottom: 12},
  msg: {fontSize: 14, color: '#f2f2f2', marginBottom: 16, lineHeight: 20},
  stack: {fontSize: 10, color: '#555', fontFamily: 'monospace', lineHeight: 14, marginBottom: 24},
  btn: {backgroundColor: '#222', borderRadius: 6, padding: 12, alignItems: 'center'},
  btnText: {color: '#f2f2f2', fontSize: 14},
});
