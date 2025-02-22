import { autoBindMethodsForReact } from 'class-autobind-decorator';
import React, { PureComponent } from 'react';
import { connect } from 'react-redux';

import { AUTOBIND_CFG } from '../../../common/constants';
import type { DocumentKey, MergeConflict } from '../../../sync/types';
import { VCS } from '../../../sync/vcs/vcs';
import { RootState } from '../../redux/modules';
import { selectSyncItems } from '../../redux/selectors';
import { Modal } from '../base/modal';
import { ModalBody } from '../base/modal-body';
import { ModalFooter } from '../base/modal-footer';
import { ModalHeader } from '../base/modal-header';

type ReduxProps = ReturnType<typeof mapStateToProps>;

interface Props extends ReduxProps {
  vcs: VCS;
}

interface State {
  conflicts: MergeConflict[];
}

@autoBindMethodsForReact(AUTOBIND_CFG)
export class UnconnectedSyncMergeModal extends PureComponent<Props, State> {
  modal: Modal | null = null;
  _handleDone: (arg0: MergeConflict[]) => void;

  state: State = {
    conflicts: [],
  };

  _setModalRef(modal: Modal) {
    this.modal = modal;
  }

  _handleOk() {
    this._handleDone(this.state.conflicts);

    this.hide();
  }

  _handleToggleSelect(key: DocumentKey, event: React.SyntheticEvent<HTMLInputElement>) {
    const conflicts = this.state.conflicts.map(c => {
      if (c.key !== key) {
        return c;
      }

      return { ...c, choose: event.currentTarget.value || null };
    });
    this.setState({
      conflicts,
    });
  }

  async show(options: {
    conflicts: MergeConflict[];
    handleDone: (arg0: MergeConflict[]) => void;
  }) {
    this.modal?.show();
    this._handleDone = options.handleDone;
    this.setState({
      conflicts: options.conflicts,
    });
  }

  hide() {
    this.modal?.hide();
  }

  render() {
    const { conflicts } = this.state;
    return (
      <Modal ref={this._setModalRef}>
        <ModalHeader key="header">Resolve Conflicts</ModalHeader>
        <ModalBody key="body" className="pad text-center" noScroll>
          <table className="table--fancy table--outlined">
            <thead>
              <tr>
                <th>Name</th>
                <th>Description</th>
                <th
                  style={{
                    width: '10rem',
                  }}
                >
                  Choose
                </th>
              </tr>
            </thead>
            <tbody>
              {conflicts.map(conflict => (
                <tr key={conflict.key}>
                  <td className="text-left">{conflict.name}</td>
                  <td className="text-left">{conflict.message}</td>
                  <td className="no-wrap">
                    <label className="no-pad">
                      Mine{' '}
                      <input
                        type="radio"
                        value={conflict.mineBlob || ''}
                        checked={conflict.choose === conflict.mineBlob}
                        onChange={e => this._handleToggleSelect(conflict.key, e)}
                      />
                    </label>
                    <label className="no-pad margin-left">
                      Theirs{' '}
                      <input
                        type="radio"
                        value={conflict.theirsBlob || ''}
                        checked={conflict.choose === conflict.theirsBlob}
                        onChange={e => this._handleToggleSelect(conflict.key, e)}
                      />
                    </label>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </ModalBody>
        <ModalFooter>
          <button className="btn" onClick={this._handleOk}>
            Submit Resolutions
          </button>
        </ModalFooter>
      </Modal>
    );
  }
}

const mapStateToProps = (state: RootState) => ({
  syncItems: selectSyncItems(state),
});

export const SyncMergeModal = connect(
  mapStateToProps,
  null,
  null,
  { forwardRef: true },
)(UnconnectedSyncMergeModal);
