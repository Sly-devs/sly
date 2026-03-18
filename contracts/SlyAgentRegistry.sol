// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";

contract SlyAgentRegistry is ERC721 {
    uint256 private _nextTokenId;
    mapping(uint256 => string) private _tokenURIs;

    event Registered(uint256 indexed agentId, string agentURI, address indexed owner);

    constructor() ERC721("Sly Agent Registry", "SLYAGENT") {}

    function register(string calldata agentURI) external returns (uint256) {
        uint256 agentId = _nextTokenId++;
        _mint(msg.sender, agentId);
        _tokenURIs[agentId] = agentURI;
        emit Registered(agentId, agentURI, msg.sender);
        return agentId;
    }

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        return _tokenURIs[tokenId];
    }
}
