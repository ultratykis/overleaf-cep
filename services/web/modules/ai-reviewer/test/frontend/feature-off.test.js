const { EditorState } = require("@codemirror/state");
const { history, undo } = require("@codemirror/commands");
const { expect } = require("chai");

const Settings = require("../../../../config/settings.defaults");

describe("AI reviewer: feature off", function () {
  it("leaves selection, editing, and Undo on the normal CodeMirror path", function () {
    expect(Settings.aiReviewer.enabled).to.equal(false);
    expect(Settings.moduleImportSequence).not.to.include("ai-reviewer");

    let state = EditorState.create({
      doc: "alpha",
      extensions: [history()],
    });
    const target = {
      get state() {
        return state;
      },
      dispatch(transaction) {
        state = transaction.state;
      },
    };

    target.dispatch(
      state.update({
        selection: {
          anchor: 0,
          head: 5,
        },
      }),
    );
    target.dispatch(
      state.update({
        changes: {
          from: 0,
          to: 5,
          insert: "beta",
        },
        userEvent: "input",
      }),
    );

    expect(state.doc.toString()).to.equal("beta");
    expect(undo(target)).to.equal(true);
    expect(state.doc.toString()).to.equal("alpha");
  });
});
